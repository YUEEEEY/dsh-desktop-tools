mod runtime;
mod server;
mod settings;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

pub struct AppState {
    pub settings: Mutex<settings::Settings>,
    pub server_child: Mutex<Option<std::process::Child>>,
    pub parsed_url: Mutex<Option<String>>,
    pub current_url: Mutex<Option<String>>,
    /// 当前窗口视图："harness"（主界面）或 "panel"（环境面板）
    pub current_view: Mutex<String>,
    pub was_ready: AtomicBool,
    pub restart_tries: AtomicU32,
    pub log_dir: PathBuf,
    pub runtime_dir: PathBuf,
    pub settings_file: PathBuf,
}

pub fn log(app: &AppHandle, line: &str) {
    // stderr 不可用时绝不能 panic：release 配置 panic=abort，一次日志写入失败会直接终止进程。
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "{}", line);
    let st = app.state::<AppState>();
    let f = st.log_dir.join("desktop.log");
    if let Ok(mut fh) = std::fs::OpenOptions::new().create(true).append(true).open(f) {
        use std::io::Write;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(fh, "[{}] {}", ts, line);
    }
}

pub fn find_url(line: &str) -> Option<String> {
    let idx = line.find("http://")?;
    let rest = &line[idx..];
    let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
    let url = &rest[..end];
    if url.contains("127.0.0.1") || url.contains("localhost") {
        Some(url.to_string())
    } else {
        None
    }
}

pub fn emit_ready(app: &AppHandle, url: &str) {
    let _ = app.emit("desktop:ready", format!("已连接 dsh Web 界面：{}", url));
}

/// 状态事件（宿主窗口加载的是远程 dsh web 页面，事件主要用于日志/调试）
pub fn emit(app: &AppHandle, phase: &str, message: &str, detail: &str) {
    let _ = app.emit(
        "desktop:status",
        format!("[{}] {} {}", phase, message, detail),
    );
}

/// 当前服务基址（http://host:port，不含路径）
fn base_url(app: &AppHandle) -> String {
    let st = app.state::<AppState>();
    let url = st
        .current_url
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| "http://127.0.0.1:3080".to_string());
    match url.find('/') {
        Some(i) if i > 7 => url[..i].to_string(),
        _ => url.trim_end_matches('/').to_string(),
    }
}

/// 视图切换："panel"（环境面板 /panel）↔ "harness"（主界面 /）
/// 由原生菜单 / 快捷键（Ctrl+Shift+P / Ctrl+Shift+H）触发。
pub fn switch_view(app: &AppHandle, view: &str) {
    let base = base_url(app);
    let target = match view {
        "panel" => format!("{}/panel", base),
        _ => format!("{}/", base),
    };
    *app.state::<AppState>().current_view.lock().unwrap() = view.to_string();
    log(app, &format!("视图切换：{} → {}", view, target));
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(u) = tauri::Url::parse(&target) {
            let _ = win.navigate(u);
        }
    }
}

/// 原生"视图"菜单：面板 / 主界面切换（含快捷键）。
fn build_view_menu(
    app: &AppHandle,
) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    use tauri::menu::{Menu, MenuItem, Submenu};
    let to_panel = MenuItem::with_id(
        app,
        "view-panel",
        "打开面板",
        true,
        Some("Ctrl+Shift+P"),
    )?;
    let to_harness = MenuItem::with_id(
        app,
        "view-harness",
        "进入主界面",
        true,
        Some("Ctrl+Shift+H"),
    )?;
    let view = Submenu::with_items(app, "视图", true, &[&to_panel, &to_harness])?;
    Menu::with_items(app, &[&view])
}

/// 启动参数（由 dsh-desktop-tools 插件或命令行传入）：
///   --url <url>       服务已由外部启动，宿主直接打开该地址的窗口
///   --serve           宿主自己启动（或连接）dsh web 服务（默认行为）
///   --port <n>        （--serve 时）服务端口，覆盖 settings.json
///   --workspace <dir> （--serve 时）工作区，覆盖 settings.json
///   --home <dir>      DSH_HOME，覆盖环境变量
#[derive(Default)]
struct LaunchOpts {
    url: Option<String>,
    serve: bool,
    port: Option<u16>,
    workspace: Option<String>,
    home: Option<String>,
}

fn parse_args() -> LaunchOpts {
    let mut opts = LaunchOpts {
        serve: true,
        ..Default::default()
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--url" => {
                opts.url = args.next();
                if opts.url.is_some() {
                    opts.serve = false;
                }
            }
            "--serve" => opts.serve = true,
            "--port" => opts.port = args.next().and_then(|s| s.parse().ok()),
            "--workspace" => opts.workspace = args.next(),
            "--home" => opts.home = args.next(),
            _ => {}
        }
    }
    opts
}

async fn bootstrap(app: AppHandle, opts: LaunchOpts) {
    if let Some(h) = &opts.home {
        std::env::set_var("DSH_HOME", h);
    }

    let target = if let Some(u) = opts.url {
        app.state::<AppState>()
            .current_url
            .lock()
            .unwrap()
            .replace(u.clone());
        u
    } else {
        // --serve：应用命令行覆盖，然后启动（或连接）服务
        {
            let st = app.state::<AppState>();
            let mut s = st.settings.lock().unwrap();
            if let Some(p) = opts.port {
                s.port = p;
            }
            if let Some(w) = opts.workspace {
                s.workspace = w;
            }
        }
        match server::start_or_connect(&app).await {
            Ok(url) => url,
            Err(e) => {
                log(&app, &format!("启动失败：{}", e));
                return;
            }
        }
    };

    if let Some(win) = app.get_webview_window("main") {
        if let Ok(u) = tauri::Url::parse(&target) {
            let _ = win.navigate(u);
        }
    }
    emit_ready(&app, &target);
}

/// WebView 导航策略：本地地址放行，其余 http(s) 外链交给系统浏览器打开。
fn handle_webview_navigation(url: &tauri::Url) -> bool {
    let is_local = url.scheme() == "about"
        || matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "tauri.localhost")
        );
    if is_local {
        return true;
    }
    if url.scheme() == "http" || url.scheme() == "https" {
        let _ = opener::open(url.as_str());
    }
    false
}

pub fn run() {
    let opts = parse_args();

    let app = tauri::Builder::default()
        .setup(move |app| {
            let user_data = app.path().app_data_dir().expect("无法获取应用数据目录");
            let _ = std::fs::create_dir_all(&user_data);
            let settings_file = user_data.join("settings.json");
            let log_dir = user_data.clone();
            let runtime_dir = user_data.join("runtime");
            let settings = settings::Settings::load(&settings_file);
            app.manage(AppState {
                settings: Mutex::new(settings),
                server_child: Mutex::new(None),
                parsed_url: Mutex::new(None),
                current_url: Mutex::new(None),
                current_view: Mutex::new("harness".to_string()),
                was_ready: AtomicBool::new(false),
                restart_tries: AtomicU32::new(0),
                log_dir,
                runtime_dir,
                settings_file,
            });

            // 原生"视图"菜单：面板 / 主界面切换（快捷键 Ctrl+Shift+P / Ctrl+Shift+H）
            if let Ok(menu) = build_view_menu(app.handle()) {
                let _ = app.set_menu(menu);
            }

            // 主窗口：先加载占位页，bootstrap 后 navigate 到 dsh web 地址
            let _window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("DSH Desktop")
            .inner_size(1240.0, 820.0)
            .min_inner_size(900.0, 620.0)
            .center()
            .on_navigation(|url| handle_webview_navigation(url))
            .on_new_window(|url, _features| {
                let _ = opener::open(url.as_str());
                tauri::webview::NewWindowResponse::<tauri::Wry>::Deny
            })
            .build()
            .expect("创建主窗口失败");

            server::supervise(app.handle());

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { bootstrap(handle, opts).await });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 tauri 应用失败");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(st) = handle.try_state::<AppState>() {
                if let Some(mut child) = st.server_child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
        // 视图菜单：打开面板 / 进入主界面
        if let tauri::RunEvent::MenuEvent(ref event) = event {
            match event.id().as_ref() {
                "view-panel" => switch_view(handle, "panel"),
                "view-harness" => switch_view(handle, "harness"),
                _ => {}
            }
        }
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } = event
        {
            if label == "main" {
                handle.exit(0);
            }
        }
    });
}

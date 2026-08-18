use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::{emit, log, AppState};

pub fn is_up(port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    match addr.parse::<std::net::SocketAddr>() {
        Ok(a) => TcpStream::connect_timeout(&a, Duration::from_millis(800)).is_ok(),
        Err(_) => false,
    }
}

/// 服务看护线程：轮询子进程状态，异常退出时自动重启（最多 3 次，退避 2s/5s/10s）。
pub fn supervise(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        let exited = {
            let st = app.state::<AppState>();
            let mut guard = st.server_child.lock().unwrap();
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        *guard = None;
                        Some(status)
                    }
                    _ => None,
                },
                None => None,
            }
        };

        if let Some(status) = exited {
            let code = status.code();
            log(&app, &format!("dsh 服务进程退出 code={:?}", code));
            let (auto, tries) = {
                let st = app.state::<AppState>();
                (
                    st.was_ready.load(Ordering::SeqCst)
                        && st.settings.lock().unwrap().auto_restart,
                    st.restart_tries.load(Ordering::SeqCst),
                )
            };
            if auto && tries < 3 {
                let delay = [2u64, 5, 10][tries.min(2) as usize];
                app.state::<AppState>()
                    .restart_tries
                    .store(tries + 1, Ordering::SeqCst);
                log(
                    &app,
                    &format!("服务异常退出，第 {} 次自动重启（{}s 后）", tries + 1, delay),
                );
                emit(
                    &app,
                    "starting",
                    &format!("dsh 服务已退出（code={:?}），{}s 后自动重启…", code, delay),
                    "",
                );
                std::thread::sleep(Duration::from_secs(delay));
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = start_or_connect(&app2).await {
                        emit(&app2, "error", &format!("自动重启失败：{}", e), "");
                    }
                });
                continue;
            }
            emit(
                &app,
                "error",
                "dsh 服务已退出，请重新打开桌面端重试",
                "详细日志见“打开日志目录”",
            );
        }
        std::thread::sleep(Duration::from_millis(500));
    });
}

/// 启动 dsh web 服务；若端口已有服务在运行则直接连接。
///
/// 能力（运行时更新 / Windows 补丁 / profile 插件注册）全部由
/// dsh-desktop-tools 插件承担，宿主只负责拉起服务进程与看护。
pub async fn start_or_connect(app: &AppHandle) -> Result<String, String> {
    let st = app.state::<AppState>();
    st.was_ready.store(false, Ordering::SeqCst);
    st.restart_tries.store(0, Ordering::SeqCst);

    let (port, workspace_cfg) = {
        let s = st.settings.lock().unwrap();
        (s.port, s.workspace.clone())
    };

    if is_up(port) {
        emit(
            app,
            "connecting",
            &format!("端口 {} 已有 dsh 服务在运行，直接连接…", port),
            "",
        );
        let url = format!("http://127.0.0.1:{}", port);
        st.current_url.lock().unwrap().replace(url.clone());
        st.was_ready.store(true, Ordering::SeqCst);
        return Ok(url);
    }

    let runtime_dir = crate::runtime::locate_runtime()
        .ok_or_else(|| "未定位到 dsh 安装（请先 npm i -g @deepseek-ai/dsh）".to_string())?;
    let bin = crate::runtime::bin_path(&runtime_dir)
        .ok_or_else(|| "未找到 dsh 运行时入口（bin.js）".to_string())?;
    let workspace = if std::path::Path::new(&workspace_cfg).exists() {
        workspace_cfg
    } else {
        dirs::home_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or(workspace_cfg)
    };

    emit(
        app,
        "starting",
        &format!("正在启动 dsh web 服务…（端口 {}，工作区：{}）", port, workspace),
        "",
    );

    // 第一次带 --port 启动；旧版 dsh CLI 不认识 --port 时自动降级为不带该参数
    // 重试（用 CLI 默认端口，实际地址以 dsh 打印的 URL 为准）。
    let first = try_start(app, &bin, &workspace, Some(port)).await?;
    if !first.unknown_option {
        return Ok(first.url);
    }
    log(
        app,
        "当前 dsh CLI 不支持 --port（运行时版本较旧？），已自动降级为默认端口启动…",
    );
    emit(
        app,
        "starting",
        "当前 dsh CLI 不接受 --port，已自动降级为默认端口启动…",
        "可在面板（/panel）点击“更新运行时”升级 dsh",
    );
    let second = try_start(app, &bin, &workspace, None).await?;
    Ok(second.url)
}

struct StartOutcome {
    url: String,
    unknown_option: bool,
}

/// 一次“拉起 dsh 进程并等待就绪”的尝试。
/// 进程因 CLI 语法错误（unknown option）快速退出时返回 `unknown_option: true`，
/// 由调用方决定是否降级重试。
async fn try_start(
    app: &AppHandle,
    bin: &str,
    workspace: &str,
    port: Option<u16>,
) -> Result<StartOutcome, String> {
    let st = app.state::<AppState>();
    let runtime_dir = st.runtime_dir.clone();

    let mut cmd = Command::new("node");
    cmd.arg(bin)
        .arg("--profile")
        .arg("web")
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(p) = port {
        cmd.arg("--port").arg(p.to_string());
    }
    if let Some(h) = std::env::var_os("DSH_HOME") {
        cmd.env("DSH_HOME", h);
    }
    // 让 dsh-desktop-tools 插件定位本宿主管理的运行时目录
    cmd.env("DSH_RUNTIME_DIR", &runtime_dir);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 node/dsh 进程：{}", e))?;
    log(app, &format!("已启动 dsh 服务进程 pid={}", child.id()));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *st.server_child.lock().unwrap() = Some(child);

    // 记录 stderr 前 4KB，用于诊断“进程快速退出”的原因（如 unknown option）。
    let early_stderr = Arc::new(Mutex::new(String::new()));
    let spawn_reader = |stream: Option<Box<dyn std::io::Read + Send>>,
                        app: AppHandle,
                        cap: Arc<Mutex<String>>| {
        if let Some(out) = stream {
            std::thread::spawn(move || {
                let mut n = 0usize;
                for line in BufReader::new(out).lines() {
                    let Ok(line) = line else { break };
                    log(&app, &format!("[dsh] {}", line));
                    if n < 64 {
                        let mut buf = cap.lock().unwrap();
                        if buf.len() < 4096 {
                            buf.push_str(&line);
                            buf.push('\n');
                        }
                        n += 1;
                    }
                    if let Some(url) = crate::find_url(&line) {
                        app.state::<AppState>()
                            .parsed_url
                            .lock()
                            .unwrap()
                            .replace(url);
                    }
                }
            });
        }
    };
    spawn_reader(
        stdout.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        app.clone(),
        early_stderr.clone(),
    );
    spawn_reader(
        stderr.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        app.clone(),
        early_stderr.clone(),
    );

    let deadline = Instant::now() + Duration::from_secs(180);
    let mut last_probe = Instant::now();
    // 就绪探测：显式 --port 时探测配置端口；降级模式（无 --port）以 stdout 里
    // dsh 打印的地址端口为准，配置端口作为兜底。
    let probe = |app: &AppHandle| -> bool {
        let parsed = app.state::<AppState>().parsed_url.lock().unwrap().clone();
        if let Some(u) = parsed {
            if let Ok(pa) = u.parse::<std::net::SocketAddr>() {
                if is_up(pa.port()) {
                    return true;
                }
            }
        }
        port.map(is_up).unwrap_or(false)
    };
    loop {
        if probe(app) {
            break;
        }
        let exited = {
            let mut guard = st.server_child.lock().unwrap();
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        *guard = None;
                        Some(status)
                    }
                    _ => None,
                },
                None => None,
            }
        };
        if let Some(status) = exited {
            let code = status.code();
            log(app, &format!("dsh 服务进程退出 code={:?}", code));
            let err = early_stderr.lock().unwrap().clone();
            if code == Some(1) && err.contains("unknown option") {
                log(app, "检测到 CLI 语法错误（unknown option），等待调用方降级重试");
                return Ok(StartOutcome {
                    url: String::new(),
                    unknown_option: true,
                });
            }
            let hint = err.trim();
            let detail = if hint.is_empty() {
                format!("dsh 服务进程提前退出（code={:?}）", code)
            } else {
                format!(
                    "dsh 服务进程提前退出（code={:?}）：{}",
                    code,
                    hint.lines().last().unwrap_or("")
                )
            };
            return Err(detail);
        }
        if Instant::now() > deadline {
            return Err("等待服务就绪超时（180s）".into());
        }
        if last_probe.elapsed() >= Duration::from_secs(8) {
            log(app, "等待服务就绪中…");
            last_probe = Instant::now();
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
    }

    let url = st
        .parsed_url
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", port.unwrap_or(3080)));
    log(app, &format!("服务就绪：{}", url));
    st.current_url.lock().unwrap().replace(url.clone());
    st.was_ready.store(true, Ordering::SeqCst);
    Ok(StartOutcome {
        url,
        unknown_option: false,
    })
}

pub async fn restart(app: &AppHandle) -> Result<(), String> {
    {
        let st = app.state::<AppState>();
        if let Some(mut child) = st.server_child.lock().unwrap().take() {
            let _ = child.kill();
        }
        st.was_ready.store(false, Ordering::SeqCst);
        st.restart_tries.store(0, Ordering::SeqCst);
    }
    tokio::time::sleep(Duration::from_millis(1200)).await;
    match start_or_connect(app).await {
        Ok(url) => {
            crate::emit_ready(app, &url);
            Ok(())
        }
        Err(e) => Err(e),
    }
}

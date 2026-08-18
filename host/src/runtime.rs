use std::path::{Path, PathBuf};
use std::process::Command;

/// dsh 启动脚本：<根>/node_modules/@deepseek-ai/dsh/lib/bin.js
pub fn bin_path(runtime_dir: &Path) -> Option<String> {
    let p = runtime_dir
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");
    if p.exists() {
        Some(p.to_string_lossy().into_owned())
    } else {
        None
    }
}

/// 运行时根目录定位顺序：
/// 1) 环境变量 DSH_RUNTIME_DIR（插件拉起宿主时显式注入）
/// 2) npm 全局安装（npm root -g 的父级）
pub fn locate_runtime() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("DSH_RUNTIME_DIR") {
        let p = PathBuf::from(dir);
        if bin_path(&p).is_some() {
            return Some(p);
        }
    }
    let out = Command::new(if cfg!(windows) { "npm.cmd" } else { "npm" })
        .args(["root", "-g"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if line.is_empty() {
        return None;
    }
    let prefix = Path::new(&line).parent()?;
    if bin_path(prefix).is_some() {
        return Some(prefix.to_path_buf());
    }
    None
}

/// 读取已安装 dsh 的版本（用于界面展示，可选）
pub fn installed_version(runtime_dir: &Path) -> Option<String> {
    let p = runtime_dir
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json");
    let text = std::fs::read_to_string(p).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

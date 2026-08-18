use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub workspace: String,
    pub port: u16,
    pub check_updates_on_launch: bool,
    pub auto_restart: bool,
}

impl Default for Settings {
    fn default() -> Self {
        let home = dirs::home_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        Self {
            workspace: home,
            port: 3080,
            check_updates_on_launch: true,
            auto_restart: true,
        }
    }
}

impl Settings {
    pub fn load(file: &Path) -> Self {
        std::fs::read_to_string(file)
            .ok()
            // 兼容带 UTF-8 BOM 的文件（部分编辑器保存时会加）
            .map(|s| s.trim_start_matches('\u{feff}').to_string())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, file: &Path) {
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(file, json);
        }
    }
}

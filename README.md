# dsh-desktop-tools

**dsh 环境管理插件**（纯 dsh 插件，无桌面壳依赖）。

原 DSH Desktop 桌面壳的核心能力，按 dsh"一切皆插件"理念重构为原生插件：
其他电脑只需安装 dsh，再安装本插件（或 clone 本仓库），即可获得
**桌面窗口（自动打开）**、运行时管理、Windows 补丁、面板、计费等完整环境能力。

## 能力

| 路由 | 说明 |
|---|---|
| `/panel` | 综合面板：dsh 运行时版本 / 一键更新 / Windows 补丁状态与重打 / 计费摘要 / **打开桌面端** |
| `/billing` | 计费页：DeepSeek 官方余额 + 全部会话 token 用量 + 估算花费 |
| `/api/runtime` | `GET` 运行时状态（已装/最新/可更新）；`POST` 后台执行 dsh 更新（`npm install`） |
| `/api/runtime/log` | 更新日志尾部 + 是否仍在运行 |
| `/api/patches` | `GET` 补丁状态；`POST` 重新应用 Windows 补丁 |
| `/api/desktop` | `GET` 宿主状态；`POST` 打开桌面窗口 |
| `/api/billing` | 计费 JSON（余额 / 用量 / 估算花费） |

## 桌面端（自动打开）

`dsh web` 启动后，插件在服务就绪时**自动打开 Rust 桌面窗口**：

- 宿主二进制内嵌于插件包 `desktop/win32-x64/dsh-desktop.exe`（Rust/Tauri v2，随插件分发）
- `dsh web --no-desktop` 关闭自动开窗；`dsh web --desktop` 强制打开
- 配置项 `autoOpenDesktop`（默认 `true`）控制默认行为
- 宿主定位顺序：`desktopBin` 配置 → `DSH_DESKTOP_BIN` 环境变量 → 插件内嵌 → 仓库构建 → PATH

插件加载时默认自动重打 Windows 补丁（`Config.autoApplyPatches`，默认 `true`，幂等）：

1. **subprocess-local win32 进程检查器**：修复
   `terminal inspection is unsupported on platform win32`（注入基于 PowerShell 的
   `WindowsProcessInspector`；当前 rc.7 仍缺失，补丁必需）。
2. **minimal preset → pwsh 工具**：win32 下禁用 bash 持久终端，改用 `@deepseek-ai/dsh-tool-pwsh`。

## 运行时定位顺序（补丁 / 更新目标）

1. 环境变量 `DSH_RUNTIME_DIR`（桌面壳兼容模式，显式指定运行时）；
2. 当前正在运行的 dsh 实例（`process.argv[1]` → `<安装>/lib/bin.js`，无壳默认路径）；
3. npm 全局安装的 `@deepseek-ai/dsh`；
4. 插件自身所在运行时的目录上溯。

无法定位时，补丁与更新功能返回"未定位到 dsh 安装"，计费与页面功能不受影响。

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `autoApplyPatches` | `true` | 加载时自动重打 Windows 补丁（幂等） |
| `checkUpdatesOnLaunch` | `true` | 加载时异步检查新版本并提示 |
| `updateMode` | `auto` | `auto`：有 `DSH_RUNTIME_DIR` 用 `--prefix`，否则 `npm i -g`；`global`/`prefix` 强制指定 |
| `prices` | DeepSeek-V4-Flash 空闲时段价 | 估算单价（¥/百万 tokens） |

## 安装

```powershell
# 本地路径（仓库内 / file: 引用）
dsh plugin --profile web add file:D:/path/to/dsh-env/plugins/dsh-desktop-tools

# 发布到 npm 后
dsh plugin --profile web add dsh-desktop-tools

# git 来源（发布到 GitHub 后）
dsh plugin --profile web add git+https://github.com/<user>/<repo>.git
```

安装后访问 `http://127.0.0.1:<port>/panel` 即可使用面板。

## 开发

```
plugins/dsh-desktop-tools/
├─ package.json       # dsh.bundle.patch 声明挂载
├─ cordis.patch.yml   # 插件挂载层（insert desktop-tools）
├─ lib/index.js       # 插件本体（cordis 插件：export { Config, apply, inject, name }）
└─ README.md
```

改动后在 profile 目录重跑 `pnpm install` 并重启 dsh 服务即可生效。

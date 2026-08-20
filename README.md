# dsh-desktop-tools

**dsh 环境管理插件**（TypeScript）：桌面窗口、运行时管理、平台兼容、计费面板、代码编辑器。

[![npm version](https://img.shields.io/npm/v/dsh-desktop-tools?color=4D6BFE&label=npm)](https://www.npmjs.com/package/dsh-desktop-tools)
[![npm downloads](https://img.shields.io/npm/dt/dsh-desktop-tools?color=4D6BFE&label=downloads)](https://www.npmjs.com/package/dsh-desktop-tools)
[![GitHub stars](https://img.shields.io/github/stars/YUEEEEY/dsh-desktop-tools?label=stars&color=4D6BFE)](https://github.com/YUEEEEY/dsh-desktop-tools)
[![License: MIT](https://img.shields.io/badge/License-MIT-2EA44F.svg)](LICENSE)

按 dsh"一切皆插件"理念实现的环境管理插件：**安装即配备桌面窗口**（Rust/Tauri 宿主按系统自动获取）、
**运行时一键更新**、**平台兼容自动适配**、**DeepSeek 官方计费**，以及**内置代码编辑器**。
桌面窗口由独立仓库 [dsh-desktop-host](https://github.com/YUEEEEY/dsh-desktop-host) 提供——
宿主轻量原生（约 5MB，非 Electron），所有环境能力仍由 dsh 插件承担，**换宿主不改变环境**。

## 特性

- 🪟 **桌面窗口（自动携带）**：安装插件时自动下载/构建对应系统的宿主二进制，`dsh web` 启动即自动打开桌面窗口；无需手动编译、无需设置环境变量。
- 🔄 **运行时一键更新**：面板检测 `@deepseek-ai/dsh` 新版本，后台 `npm install` 升级并查看日志。
- 🛡️ **平台兼容自愈**：Windows 下自动适配终端/进程能力与命令工具（幂等、静默、无需干预）。
- 💰 **官方计费面板**：DeepSeek 账户余额 + 全部会话 token 用量 + 估算花费（可自定义单价）。
- 📝 **代码编辑器**：主窗口内浏览/编辑工作区文件，保存即落盘——配合 dsh agent 人工复核文件改动。
- 🖥️ **环境面板弹窗**：宿主托盘/快捷键打开独立面板窗口，不打断主界面。
- 🪶 **轻量原生**：纯 dsh 插件（无壳依赖）+ Tauri 2 宿主（约 5MB 二进制，Windows / macOS / Linux）。

## 安装

```powershell
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-desktop-tools

# 或从 GitHub 仓库安装（源码/开发版）
dsh plugin --profile web add git+https://github.com/YUEEEEY/dsh-desktop-tools.git

# 或本地开发（file: 引用）
dsh plugin --profile web add file:<本插件目录>
```

安装后启动 `dsh web`：插件会自动获取桌面宿主并打开桌面窗口；`dsh web --no-desktop` 可关闭自动开窗。

> 宿主获取方式：优先从 [dsh-desktop-host Releases](https://github.com/YUEEEEY/dsh-desktop-host/releases)
> 下载当前系统对应二进制到 `$DSH_HOME/desktop-host/<platform>-<arch>/`；找不到对应资产时回退
> clone 源码 `cargo build --release`。网络不可用时插件照常工作（仅暂不打开桌面窗口），
> 之后可在面板点击"重新获取宿主"。

## 桌面端

桌面窗口由 Rust/Tauri 宿主提供，主要能力：

- **系统托盘**：显示/隐藏窗口、打开环境面板（弹窗）、打开代码编辑器、在浏览器打开、重启服务、检查更新、开机自启、退出。
- **面板弹窗**：`Ctrl+Shift+P` 或托盘/菜单打开独立面板窗口（宿主状态 / 运行时 / 平台兼容 / 计费摘要）。
- **代码编辑器**：`Ctrl+Shift+E` 或托盘/菜单在主窗口内打开（浏览与编辑工作区文件）。
- **单实例 / 开机自启 / 窗口状态记忆**：重复启动聚焦已有窗口；托盘一键自启；记住窗口位置与尺寸。
- **自动更新提示**：每 6 小时检查 dsh 运行时更新，发现新版本时托盘提示。

宿主定位顺序：`desktopBin` 配置 → `DSH_DESKTOP_BIN` 环境变量 → 自动获取缓存目录 → 仓库构建产物 → PATH。

## 代码编辑器

**对话视图 ⇄ 代码视图** 双向切换（Qoder / WorkBuddy 式交互）：

- 对话页右下角「⌘ 代码」按钮（或宿主菜单/托盘、`Ctrl+Shift+E`）进入代码视图；
- 代码视图顶部「对话 / 代码」切换（或 `Ctrl+B`）回到对话视图。

代码视图内置布局：

- **左侧对话侧栏**：嵌入当前会话（可拖动调整宽度、可折叠），编辑文件时对话不中断；
- **文件树**：工作区文件浏览（默认跳过 `.git` / `node_modules` 等，惰性展开）；
- **多标签编辑器**：按扩展名识别语言，`Ctrl+S` 保存，未保存标记、状态栏（路径/语言/行列）；
- 编辑器内核为 Monaco（优先 npmmirror CDN，jsdelivr 兜底，离线降级内置编辑器）；
- 文件 API（`/api/fs/tree|read|write`）严格限定在工作区根目录内，仅本地访问；
- 默认根目录为 dsh 工作区，可用配置 `editorRoot` 覆盖。

## 路由

| 路由 | 说明 |
|---|---|
| `/panel` | 环境面板：宿主状态 / 运行时版本与更新 / 平台兼容 / 计费摘要（宿主内为弹窗） |
| `/billing` | 计费页：DeepSeek 官方余额 + 全部会话 token 用量 + 估算花费 |
| `/editor` | 代码编辑器：工作区文件浏览 / 编辑 |
| `/api/runtime` | `GET` 运行时状态（已装/最新/可更新）；`POST` 后台执行 dsh 更新 |
| `/api/runtime/log` | 更新日志尾部 + 是否仍在运行 |
| `/api/patches` | `GET` 平台兼容状态；`POST` 重新应用 |
| `/api/desktop` | `GET` 宿主状态（含获取进度）；`POST` 打开桌面窗口 |
| `/api/host/ensure` | `POST` 触发宿主自动获取 |
| `/api/fs/tree` `/api/fs/read` `/api/fs/write` | 代码编辑器文件 API（工作区根内） |
| `/api/billing` | 计费 JSON（余额 / 用量 / 估算花费） |

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `hostAutoInstall` | `true` | 是否自动获取宿主二进制（安装时 / 加载时） |
| `autoOpenDesktop` | `true` | `dsh web` 启动后自动打开桌面窗口 |
| `desktopBin` | `""` | 宿主二进制路径（留空自动定位） |
| `editorRoot` | 工作区 | 代码编辑器根目录 |
| `autoApplyPatches` | `true` | 加载时自动应用平台兼容适配（幂等，仅 win32） |
| `checkUpdatesOnLaunch` | `true` | 加载时异步检查新版本并提示 |
| `updateMode` | `auto` | `auto`：有 `DSH_RUNTIME_DIR` 用 `--prefix`，否则 `npm i -g`；`global`/`prefix` 强制指定 |
| `prices` | DeepSeek-V4-Flash 空闲时段价 | 估算单价（¥/百万 tokens） |

## 平台兼容（Windows）

插件加载时自动适配（幂等，非 Windows 自动跳过，无需用户干预）：

1. **终端与进程能力**：为 dsh 的进程检查在 Windows 上提供实现（基于 PowerShell），
   修复终端检查能力缺失导致的报错。
2. **命令工具适配**：Windows 下将 bash 持久终端替换为 pwsh 工具。

适配状态可在面板"平台兼容"卡片查看，详情在"诊断"折叠区。

## 运行时定位顺序（更新 / 适配目标）

1. 环境变量 `DSH_RUNTIME_DIR`（显式指定运行时）；
2. 当前正在运行的 dsh 实例（`process.argv[1]` → `<安装>/lib/bin.js`）；
3. npm 全局安装的 `@deepseek-ai/dsh`；
4. 插件自身所在运行时的目录上溯。

无法定位时，更新与适配功能返回"未定位到 dsh 安装"，计费、编辑器与页面功能不受影响。

## 开发

```
plugins/dsh-desktop-tools/
├─ src/index.ts         # 插件源码（TypeScript）
├─ src/bin.ts           # 桌面端入口命令（dsh-desktop）
├─ scripts/ensure-host.mjs  # 宿主自动获取（Release 下载 / 源码构建）
├─ tsconfig.json        # tsc 构建配置
├─ lib/                 # 构建产物（npm run build 生成）
├─ package.json         # dsh.bundle.patch 声明挂载；postinstall 触发宿主获取
└─ cordis.patch.yml     # 插件挂载层（insert desktop-tools）
```

改动后：`npm run build` 重新编译，仓库内重跑 `pnpm install` 并重启 dsh 服务生效；
发布新版本用 `npm publish`。

宿主源码与构建：见 [dsh-desktop-host](https://github.com/YUEEEEY/dsh-desktop-host)。

## License

MIT

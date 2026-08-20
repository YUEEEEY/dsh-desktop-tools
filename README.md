# dsh-desktop-tools

**dsh 环境管理插件**（TypeScript）。

按 dsh"一切皆插件"理念实现的环境管理插件：**桌面窗口（自动打开）**、运行时管理、
Windows 补丁、面板、计费等完整能力。桌面窗口由独立的 Rust 宿主提供，
宿主源码在独立仓库 [dsh-desktop-host](https://github.com/YUEEEEY/dsh-desktop-host)，
按你的操作系统 `cargo build --release` 后设置 `DSH_DESKTOP_BIN` 即可。

## 安装

```powershell
# 推荐：从 npm 安装
dsh plugin --profile web add dsh-desktop-tools

# 或从 GitHub 仓库安装（源码/开发版）
dsh plugin --profile web add git+https://github.com/YUEEEEY/dsh-desktop-tools.git

# 或本地开发（file: 引用）
dsh plugin --profile web add file:<本插件目录>
```

安装后启动：`dsh web` —— 服务就绪后自动打开桌面端窗口（需已构建宿主并设置 `DSH_DESKTOP_BIN`）。

## 桌面端（自动打开）

`dsh web` 启动后，插件在服务就绪时**自动打开 Rust 桌面窗口**：

1. 克隆宿主源码并按你的系统构建：

   ```bash
   git clone https://github.com/YUEEEEY/dsh-desktop-host.git
   cd dsh-desktop-host && cargo build --release
   # 产物：target/release/dsh-desktop（Windows 为 dsh-desktop.exe）
   ```

2. 把产物路径告诉插件（任选其一）：

   ```bash
   # 环境变量（推荐，可写入 shell 配置）
   export DSH_DESKTOP_BIN=/path/to/dsh-desktop-host/target/release/dsh-desktop
   # Windows PowerShell:
   # $env:DSH_DESKTOP_BIN = "C:\path\to\dsh-desktop.exe"
   ```

   ```yaml
   # 或 profile 的 cordis.patch.yml 配置 desktopBin：
   # - id: desktop-tools
   #   config:
   #     desktopBin: /path/to/dsh-desktop
   ```

3. `dsh web` —— 自动打开桌面窗口；`dsh web --no-desktop` 关闭自动开窗。

- 桌面窗口内：`Ctrl+Shift+P` 打开环境面板、`Ctrl+Shift+H` 回到主界面（或菜单"视图"）
- 宿主定位顺序：`desktopBin` 配置 → `DSH_DESKTOP_BIN` 环境变量 → 仓库内构建产物 → PATH

## 能力

| 路由 | 说明 |
|---|---|
| `/panel` | 综合面板：dsh 运行时版本 / 一键更新 / Windows 补丁 / 计费摘要 / **打开桌面端** |
| `/billing` | 计费页：DeepSeek 官方余额 + 全部会话 token 用量 + 估算花费 |
| `/api/runtime` | `GET` 运行时状态（已装/最新/可更新）；`POST` 后台执行 dsh 更新（`npm install`） |
| `/api/runtime/log` | 更新日志尾部 + 是否仍在运行 |
| `/api/patches` | `GET` 补丁状态；`POST` 重新应用 Windows 补丁 |
| `/api/desktop` | `GET` 宿主状态；`POST` 打开桌面窗口 |
| `/api/billing` | 计费 JSON（余额 / 用量 / 估算花费） |

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `autoApplyPatches` | `true` | 加载时自动重打 Windows 补丁（幂等，仅 win32） |
| `checkUpdatesOnLaunch` | `true` | 加载时异步检查新版本并提示 |
| `updateMode` | `auto` | `auto`：有 `DSH_RUNTIME_DIR` 用 `--prefix`，否则 `npm i -g`；`global`/`prefix` 强制指定 |
| `autoOpenDesktop` | `true` | `dsh web` 启动后自动打开桌面窗口 |
| `desktopBin` | `""` | 宿主二进制路径（留空自动定位） |
| `prices` | DeepSeek-V4-Flash 空闲时段价 | 估算单价（¥/百万 tokens） |

## Windows 补丁

插件加载时默认自动重打 Windows 补丁（幂等，非 Windows 自动跳过）：

1. **subprocess-local win32 进程检查器**：修复
   `terminal inspection is unsupported on platform win32`（注入基于 PowerShell 的
   `WindowsProcessInspector`）。
2. **minimal preset → pwsh 工具**：win32 下禁用 bash 持久终端，改用 `@deepseek-ai/dsh-tool-pwsh`。

## 运行时定位顺序（补丁 / 更新目标）

1. 环境变量 `DSH_RUNTIME_DIR`（显式指定运行时）；
2. 当前正在运行的 dsh 实例（`process.argv[1]` → `<安装>/lib/bin.js`）；
3. npm 全局安装的 `@deepseek-ai/dsh`；
4. 插件自身所在运行时的目录上溯。

无法定位时，补丁与更新功能返回"未定位到 dsh 安装"，计费与页面功能不受影响。

## 开发

```
plugins/dsh-desktop-tools/
├─ src/index.ts       # 插件源码（TypeScript）
├─ tsconfig.json      # tsc 构建配置
├─ lib/index.js       # 构建产物（npm run build / prepare 生成）
├─ package.json       # dsh.bundle.patch 声明挂载；bin: dsh-desktop
├─ cordis.patch.yml   # 插件挂载层（insert desktop-tools）
└─ bin/dsh-desktop.js # 桌面端入口命令（dsh-desktop）
```

改动后：`npm run build` 重新编译，仓库内重跑 `pnpm install` 并重启 dsh 服务生效；
发布新版本用 `npm publish`。

宿主源码与构建：见 [dsh-desktop-host](https://github.com/YUEEEEY/dsh-desktop-host)。

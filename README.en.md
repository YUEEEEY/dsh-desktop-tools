# dsh-desktop-tools

**dsh environment management plugin** (TypeScript): desktop window, runtime management, platform compatibility, billing panel, code editor.

[![npm version](https://img.shields.io/npm/v/dsh-desktop-tools?color=4D6BFE&label=npm)](https://www.npmjs.com/package/dsh-desktop-tools)
[![npm downloads](https://img.shields.io/npm/dt/dsh-desktop-tools?color=4D6BFE&label=downloads)](https://www.npmjs.com/package/dsh-desktop-tools)
[![GitHub stars](https://img.shields.io/github/stars/YUEEEEY/dsh-desktop-tools?label=stars&color=4D6BFE)](https://github.com/YUEEEEY/dsh-desktop-tools)
[![License: MIT](https://img.shields.io/badge/License-MIT-2EA44F.svg)](LICENSE)

An environment management plugin built on the dsh "everything is a plugin" model:
**desktop window included on install** (a Rust/Tauri host is fetched automatically for your OS),
**one-click runtime updates**, **automatic platform compatibility**, **official DeepSeek billing**,
and a **built-in code editor**.

The desktop window is provided by the standalone repo [dsh-desktop-host](https://github.com/YUEEEEY/dsh-desktop-host) —
a lightweight native host (~5 MB, not Electron). All environment capabilities stay in the dsh plugin,
so **swapping the host does not change your environment**.

## Features

- 🪟 **Desktop window, auto-included** — installing the plugin fetches (or builds) the matching host binary for your OS; `dsh web` opens the desktop window automatically. No manual builds, no environment variables.
- 🔄 **One-click runtime update** — the panel detects new `@deepseek-ai/dsh` versions, upgrades in the background (`npm install`), and shows the log.
- 🛡️ **Platform compatibility, self-healing** — on Windows, terminal/process inspection and command tools are adapted automatically (idempotent, silent).
- 💰 **Official billing panel** — DeepSeek account balance + token usage across all sessions + estimated cost (customizable prices).
- 📝 **Code editor** — browse and edit workspace files inside the desktop window; Ctrl+S writes to disk.
- 🖥️ **Panel as a popup** — the environment panel opens in its own small window from the tray/shortcuts, without interrupting the main view.
- 🪶 **Lightweight native** — pure dsh plugin (no shell dependency) + Tauri 2 host (~5 MB binary; Windows / macOS / Linux).

## Install

```bash
# from npm (recommended)
dsh plugin --profile web add dsh-desktop-tools

# or from the GitHub repo (source / dev)
dsh plugin --profile web add git+https://github.com/YUEEEEY/dsh-desktop-tools.git

# or local development (file: reference)
dsh plugin --profile web add file:<this-directory>
```

Then run `dsh web` — the plugin fetches the desktop host and opens the window automatically;
use `dsh web --no-desktop` to disable auto-open.

> Host acquisition: the latest [dsh-desktop-host release](https://github.com/YUEEEEY/dsh-desktop-host/releases)
> is downloaded for your platform into `$DSH_HOME/desktop-host/<platform>-<arch>/`; if no matching asset
> exists, the source is cloned and built with `cargo build --release`. If the network is unavailable the
> plugin keeps working (just no window yet) — trigger "重新获取宿主" from the panel later.

## Desktop

The desktop window is provided by the Rust/Tauri host:

- **System tray**: show/hide window, open panel (popup), open code editor, open in browser, restart service, check updates, autostart, quit.
- **Panel popup**: `Ctrl+Shift+P` or tray/menu opens the environment panel in its own window.
- **Code editor**: `Ctrl+Shift+E` or tray/menu opens the editor inside the main window.
- **Single instance / autostart / window state**: repeated launches focus the existing window; one-click autostart; window position/size are remembered.
- **Update prompt**: checks for dsh runtime updates every 6 hours and notifies via the tray.

Host lookup order: `desktopBin` config → `DSH_DESKTOP_BIN` env → auto-fetch cache dir → repo build output → PATH.

## Code editor

Opened inside the main window (`Ctrl+Shift+E` / tray / menu) for reading and editing workspace files:

- file tree on the left (`.git` / `node_modules` etc. skipped), editor on the right, language detected by extension;
- `Ctrl+S` saves to disk; `Ctrl+Shift+B` or the in-page back button returns to the main view;
- Monaco-based editor (loaded on demand; a built-in editor is used when offline);
- the file API (`/api/fs/tree|read|write`) is strictly confined to the workspace root and loopback-only;
- default root is the dsh workspace; override with the `editorRoot` config.

## Routes

| Route | Description |
|---|---|
| `/panel` | Environment panel: host status / runtime version & update / platform compatibility / billing summary |
| `/billing` | Billing: DeepSeek balance + session token usage + estimated cost |
| `/editor` | Code editor: workspace file browsing / editing |
| `/api/runtime` | `GET` runtime status; `POST` trigger background dsh update |
| `/api/runtime/log` | Update log tail + running state |
| `/api/patches` | `GET` platform-compat status; `POST` re-apply |
| `/api/desktop` | `GET` host status (incl. acquisition progress); `POST` open the desktop window |
| `/api/host/ensure` | `POST` trigger host acquisition |
| `/api/fs/tree` `/api/fs/read` `/api/fs/write` | Code editor file API (workspace-root confined) |
| `/api/billing` | Billing JSON (balance / usage / estimated cost) |

## Configuration

| Key | Default | Description |
|---|---|---|
| `hostAutoInstall` | `true` | auto-fetch the host binary (at install / at load) |
| `autoOpenDesktop` | `true` | open the desktop window when `dsh web` starts |
| `desktopBin` | `""` | explicit host binary path (empty = auto-locate) |
| `editorRoot` | workspace | code editor root directory |
| `autoApplyPatches` | `true` | apply platform-compat adaptations on load (idempotent, win32 only) |
| `checkUpdatesOnLaunch` | `true` | check for new versions on load and prompt |
| `updateMode` | `auto` | `auto`: `--prefix` when `DSH_RUNTIME_DIR` is set, else `npm i -g`; `global`/`prefix` to force |
| `prices` | DeepSeek-V4-Flash off-peak | estimated prices (¥ per million tokens) |

## Platform compatibility (Windows)

Applied automatically on load (idempotent; skipped on non-Windows; no user action needed):

1. **Terminal & process inspection** — provides a Windows implementation for dsh's process inspection (PowerShell-based), fixing the missing terminal-inspection capability.
2. **Command tools** — replaces the bash persistent terminal with the pwsh tool on Windows.

Status is shown on the panel's "Platform compatibility" card; details live under "Diagnostics".

## Runtime lookup order (update / adapt targets)

1. `DSH_RUNTIME_DIR` env (explicit runtime);
2. the currently running dsh instance (`process.argv[1]` → `<install>/lib/bin.js`);
3. the npm global `@deepseek-ai/dsh`;
4. walking up from the plugin's own runtime.

When the runtime cannot be located, update/adapt features report "dsh install not located"; billing, editor and pages keep working.

## Development

```
plugins/dsh-desktop-tools/
├─ src/index.ts             # plugin source (TypeScript)
├─ src/bin.ts               # desktop entry command (dsh-desktop)
├─ scripts/ensure-host.mjs  # host auto-fetch (release download / source build)
├─ tsconfig.json            # tsc build config
├─ lib/                     # build output (npm run build)
├─ package.json             # dsh.bundle.patch mount; postinstall fetches the host
└─ cordis.patch.yml         # plugin mount layer (insert desktop-tools)
```

After changes: `npm run build`, re-run `pnpm install` in the profile and restart the dsh service;
publish with `npm publish`.

Host source & build: see [dsh-desktop-host](https://github.com/YUEEEEY/dsh-desktop-host).

## License

MIT

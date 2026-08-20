# Changelog

## 0.5.0 — 2026-08-20

- Code-review loop in the code view (Codex/Qoder/WorkBuddy-style):
  - **Disk change detection**: the editor watches the workspace and shows a
    "↻" badge on tabs whose files changed on disk (e.g. after the agent edits
    them); non-dirty tabs reload automatically, deleted files are flagged "✕".
    The file tree refreshes automatically and keeps expanded folders.
  - **🤖 审查此文件**: one click copies a review prompt for the current file
    and focuses the conversation sidebar, ready to paste and send.
  - **切换目录**: switch the workspace root at runtime (same-origin guarded),
    e.g. open another project without restarting.
  - Change-tracking scans run only while the editor is open (idle timeout),
    skipping `.git`/`node_modules` etc.; mutating fs endpoints are
    same-origin-checked.

## 0.4.1 — 2026-08-20

- Code editor UX overhaul (Qoder/WorkBuddy-style): conversation view ↔ code view
  switching — a floating "⌘ 代码" button on the chat page opens the editor, and the
  editor's top bar switches back to the chat view.
- The code view embeds the conversation in a resizable left sidebar (same-origin
  iframe), so the chat stays visible while editing; the file tree sits beside it.
- Editor fixes: multi-file tabs with unsaved markers and per-tab close, a status
  bar (path/language/line-col/save state), Monaco loaded from the npmmirror CDN
  first (China-friendly) with jsdelivr fallback and a built-in editor as last
  resort, and active-file highlighting in the tree.

## 0.4.0 — 2026-08-20

- Host auto-install: installing the plugin fetches the matching `dsh-desktop-host`
  binary for your OS — GitHub Release download first, source build as fallback —
  no manual `cargo build` / `DSH_DESKTOP_BIN` needed (cache: `$DSH_HOME/desktop-host/`).
- Code editor: new `/editor` page and `/api/fs` file API (tree/read/write,
  workspace-root confined). Monaco-based editor with a built-in fallback,
  opened inside the desktop window (`Ctrl+Shift+E` / tray / menu).
- Panel opens as a popup window in the desktop host (`Ctrl+Shift+P` / tray / menu);
  the main window stays on the harness view.
- "Windows patches" are presented as a platform-compatibility layer
  (自动适配，无需干预), auto-applied and mostly hidden in the UI; details stay
  under the panel's diagnostics.
- Zed-inspired dark UI for the panel, billing and editor pages.
- Host: system tray (show/hide, panel, editor, open in browser, restart service,
  check updates, autostart, quit), single instance, autostart, window-state
  memory, zoom/devtools/reload menu, 6-hour update check with tray prompt.

## 0.1.6 — 2026-08-20

- Fix: `spawn EINVAL` on Windows when running `npm.cmd` via `execFile`/`execFileSync`
  (now executed through the shell on Windows). Fixes plugin load failure on `dsh web`.

## 0.1.5 — 2026-08-20

- Cross-platform host binaries: win32-x64, linux-x64, darwin-arm64 built via GitHub Actions.

## 0.1.4 — 2026-08-20

- Cross-platform support: platform-aware plugin (patches/commands/host paths),
  `install.sh` for macOS/Linux, CI build workflow.

## 0.1.3 — 2026-08-18

- Repository metadata points to the standalone open-source repo.

## 0.1.2 — 2026-08-18

- Desktop host view switching: `Ctrl+Shift+P` (panel) / `Ctrl+Shift+H` (harness),
  plus a native "View" menu.

## 0.1.1 — 2026-08-18

- README rewritten for published distribution.

## 0.1.0 — 2026-08-18

- Initial release: runtime management, Windows patches, panel/billing, embedded Rust desktop host.

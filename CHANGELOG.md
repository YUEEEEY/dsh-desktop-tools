# Changelog

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

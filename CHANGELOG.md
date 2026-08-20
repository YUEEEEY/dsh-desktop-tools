# Changelog

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

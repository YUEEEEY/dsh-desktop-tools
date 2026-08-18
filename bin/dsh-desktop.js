#!/usr/bin/env node
// dsh-desktop —— 桌面端入口（dsh-desktop-tools 插件提供）
//
// 职责：定位 Rust 窗口宿主（dsh-desktop.exe），探测 dsh 服务是否在跑，
// 然后以 --url（服务已跑）或 --serve（由宿主拉起服务）方式启动宿主窗口。
//
// 宿主定位顺序：
//   1) 环境变量 DSH_DESKTOP_BIN
//   2) 插件内嵌：<dsh-env>/plugins/dsh-desktop-tools/desktop/win32-x64/dsh-desktop(.exe)
//   3) 仓库内开发构建：<dsh-env>/host/target/release/dsh-desktop(.exe)
//   4) PATH 中的 dsh-desktop
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";

const isWin = process.platform === "win32";
const exeName = isWin ? "dsh-desktop.exe" : "dsh-desktop";

function locateHost() {
  if (process.env.DSH_DESKTOP_BIN && existsSync(process.env.DSH_DESKTOP_BIN)) {
    return process.env.DSH_DESKTOP_BIN;
  }
  // 插件内嵌：plugins/dsh-desktop-tools/bin/ → ../desktop/win32-x64/
  const here = dirname(fileURLToPath(import.meta.url));
  const embedded = join(here, "..", "desktop", "win32-x64", exeName);
  if (existsSync(embedded)) return embedded;
  const dev = join(here, "..", "..", "..", "host", "target", "release", exeName);
  if (existsSync(dev)) return dev;
  return exeName; // 交给 PATH
}

function portUp(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    const done = (v) => {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

const host = locateHost();
const port = Number(process.env.DSH_DESKTOP_PORT || 3080);
const args = [];
const up = await portUp(port);
if (up) {
  args.push("--url", `http://127.0.0.1:${port}`);
} else {
  args.push("--serve", "--port", String(port));
}
if (process.env.DSH_HOME) args.push("--home", process.env.DSH_HOME);
if (process.env.DSH_DESKTOP_WORKSPACE) args.push("--workspace", process.env.DSH_DESKTOP_WORKSPACE);

console.log(`[dsh-desktop] 宿主: ${host}`);
console.log(`[dsh-desktop] 参数: ${args.join(" ")}`);

const child = spawn(host, args, {
  stdio: "inherit",
  windowsHide: true,
});
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (e) => {
  console.error(`[dsh-desktop] 启动宿主失败：${e.message}`);
  console.error(`[dsh-desktop] 请先在 dsh-env/desktop 运行 cargo build --release`);
  process.exit(1);
});

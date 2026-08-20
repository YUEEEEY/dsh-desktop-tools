#!/usr/bin/env node
// dsh-desktop —— 桌面端入口（dsh-desktop-tools 插件提供）
//
// 职责：定位 Rust 窗口宿主（dsh-desktop），探测 dsh 服务是否在跑，
// 然后以 --url（服务已跑）或 --serve（由宿主拉起服务）方式启动宿主窗口。
//
// 宿主定位顺序：
//   1) 环境变量 DSH_DESKTOP_BIN
//   2) 仓库内构建产物：<dsh-env>/host/target/release/dsh-desktop(.exe)
//   3) PATH 中的 dsh-desktop
// 宿主源码独立仓库：https://github.com/YUEEEEY/dsh-desktop-host（按系统 cargo build 后设置 DSH_DESKTOP_BIN）
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";

const isWin = process.platform === "win32";
const exeName = isWin ? "dsh-desktop.exe" : "dsh-desktop";

function locateHost(): string {
  if (process.env.DSH_DESKTOP_BIN && existsSync(process.env.DSH_DESKTOP_BIN)) {
    return process.env.DSH_DESKTOP_BIN;
  }
  // 仓库内构建：plugins/dsh-desktop-tools/lib/bin.js → ../../host/target/release/
  const here = dirname(fileURLToPath(import.meta.url));
  const dev = join(here, "..", "..", "..", "host", "target", "release", exeName);
  if (existsSync(dev)) return dev;
  return exeName; // 交给 PATH
}

function portUp(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    const done = (v: boolean) => {
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
const args: string[] = [];
const up = await portUp(port);
if (up) {
  args.push("--url", `http://127.0.0.1:${port}`);
} else {
  args.push("--serve", "--port", String(port));
}
if (process.env.DSH_HOME) args.push("--home", process.env.DSH_HOME);
if (process.env.DSH_DESKTOP_WORKSPACE) args.push("--workspace", process.env.DSH_DESKTOP_WORKSPACE);

console.log(`[dsh-desktop] host: ${host}`);
console.log(`[dsh-desktop] args: ${args.join(" ")}`);

const child = spawn(host, args, {
  stdio: "inherit",
  windowsHide: true,
});
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (e) => {
  console.error(`[dsh-desktop] failed to start host: ${e.message}`);
  console.error(`[dsh-desktop] clone https://github.com/YUEEEEY/dsh-desktop-host, run cargo build --release, set DSH_DESKTOP_BIN`);
  process.exit(1);
});

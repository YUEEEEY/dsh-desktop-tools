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

function locateHost() {
  if (process.env.DSH_DESKTOP_BIN && existsSync(process.env.DSH_DESKTOP_BIN)) {
    return process.env.DSH_DESKTOP_BIN;
  }
  // 仓库内构建：plugins/dsh-desktop-tools/bin/ → ../../host/target/release/
  const here = dirname(fileURLToPath(import.meta.url));
  const dev = join(here, "..", "..", "..", "host", "target", "release", exeName);
  if (existsSync(dev)) return dev;
  return exeName; // 交给 PATH
}

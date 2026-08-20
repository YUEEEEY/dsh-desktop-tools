#!/usr/bin/env node
// ensure-host.mjs —— 确保 dsh-desktop 宿主二进制可用（dsh-desktop-tools 安装时自动执行）
//
// 获取顺序：
//   1) 目标位置已存在二进制 → 直接使用；
//   2) 查询 dsh-desktop-host 仓库最新 Release，命中当前平台资产 → 下载；
//   3) 无 Release / 无对应资产 → clone 源码并 cargo build --release；
//   4) 全部失败 → 输出可读原因（退出码仍为 0，不阻断插件安装）。
//
// 用法：
//   node scripts/ensure-host.mjs            # 执行获取（幂等）
//   node scripts/ensure-host.mjs --status   # 仅输出当前状态 JSON
//
// 状态文件：$DSH_HOME/desktop-host/ensure-status.json（供面板 /api/desktop 读取）
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const HOST_REPO = "YUEEEEY/dsh-desktop-host";
// API 基址可用环境变量覆盖（本地模拟测试 / 自建镜像用）
const GITHUB_API = process.env.DSH_HOST_GITHUB_API || "https://api.github.com";
const REPO_URL = process.env.DSH_HOST_REPO_URL || `https://github.com/${HOST_REPO}.git`;
const UA = "dsh-desktop-tools (host auto-install)";

function target() {
  if (process.platform === "win32" && process.arch === "x64")
    return { dir: "win32-x64", exe: "dsh-desktop.exe", asset: "dsh-desktop-windows-x64.exe" };
  if (process.platform === "darwin" && process.arch === "arm64")
    return { dir: "darwin-arm64", exe: "dsh-desktop", asset: "dsh-desktop-darwin-arm64" };
  if (process.platform === "darwin" && process.arch === "x64")
    return { dir: "darwin-x64", exe: "dsh-desktop", asset: "dsh-desktop-darwin-x64" };
  if (process.platform === "linux" && process.arch === "x64")
    return { dir: "linux-x64", exe: "dsh-desktop", asset: "dsh-desktop-linux-x64" };
  return null;
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function hostRoot() {
  return join(dshHome(), "desktop-host");
}

function targetDir(t) {
  return join(hostRoot(), t.dir);
}

function binaryPath(t) {
  return join(targetDir(t), t.exe);
}

function statusPath() {
  return join(hostRoot(), "ensure-status.json");
}

function writeStatus(state) {
  try {
    mkdirSync(hostRoot(), { recursive: true });
    writeFileSync(statusPath(), JSON.stringify({ at: new Date().toISOString(), ...state }, null, 2), "utf8");
  } catch {
    /* 状态文件写失败不影响安装 */
  }
}

async function latestRelease() {
  const res = await fetch(`${GITHUB_API}/repos/${HOST_REPO}/releases/latest`, {
    headers: { "User-Agent": UA, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  return res.json();
}

async function download(url, dest) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/octet-stream" },
    redirect: "follow",
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, dest);
}

/** 2) GitHub Release 下载 */
async function tryRelease(t) {
  const rel = await latestRelease();
  if (!rel || !Array.isArray(rel.assets) || rel.assets.length === 0)
    return { ok: false, reason: `仓库 ${HOST_REPO} 暂无 Release` };
  const asset = rel.assets.find((a) => a.name === t.asset);
  if (!asset)
    return { ok: false, reason: `Release ${rel.tag_name} 缺少资产 ${t.asset}` };
  const dest = binaryPath(t);
  if (existsSync(dest)) return { ok: true, path: dest, source: `本地缓存（${rel.tag_name}）` };
  mkdirSync(targetDir(t), { recursive: true });
  await download(asset.browser_download_url, dest);
  return { ok: true, path: dest, source: `Release ${rel.tag_name} 下载` };
}

/** 3) 源码 clone + cargo build */
function tryBuild(t) {
  const src = join(hostRoot(), "src");
  if (!existsSync(join(src, "Cargo.toml"))) {
    process.stderr.write(`[ensure-host] 克隆宿主源码 ${REPO_URL} …\n`);
    execFileSync("git", ["clone", "--depth", "1", REPO_URL, src], {
      stdio: "inherit",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  }
  process.stderr.write("[ensure-host] cargo build --release …（首次需下载依赖，请稍候）\n");
  execFileSync("cargo", ["build", "--release"], { cwd: src, stdio: "inherit" });
  const built = join(src, "target", "release", t.exe);
  if (!existsSync(built)) throw new Error(`构建产物缺失：${built}`);
  mkdirSync(targetDir(t), { recursive: true });
  renameSync(built, binaryPath(t));
  return { ok: true, path: binaryPath(t), source: "源码构建" };
}

async function ensure() {
  const t = target();
  if (!t) {
    const msg = `当前平台 ${process.platform}-${process.arch} 暂无预编译宿主，请手动构建：git clone ${REPO_URL} && cargo build --release，并设置 DSH_DESKTOP_BIN`;
    process.stderr.write(`[ensure-host] ${msg}\n`);
    writeStatus({ state: "unsupported", error: msg });
    return;
  }
  if (process.env.DSH_DESKTOP_BIN && existsSync(process.env.DSH_DESKTOP_BIN)) {
    writeStatus({ state: "ready", path: process.env.DSH_DESKTOP_BIN, source: "DSH_DESKTOP_BIN" });
    return;
  }
  const existing = binaryPath(t);
  if (existsSync(existing)) {
    writeStatus({ state: "ready", path: existing, source: "已存在" });
    return;
  }
  try {
    const r = await tryRelease(t);
    if (r.ok) {
      writeStatus({ state: "ready", path: r.path, source: r.source });
      return;
    }
    process.stderr.write(`[ensure-host] ${r.reason}，回退到源码构建。\n`);
    const b = tryBuild(t);
    writeStatus({ state: "ready", path: b.path, source: b.source });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[ensure-host] 宿主获取失败：${msg}\n`);
    writeStatus({ state: "failed", error: msg });
  }
}

function status() {
  try {
    const p = statusPath();
    if (!existsSync(p)) {
      const t = target();
      const bin = t && existsSync(binaryPath(t)) ? binaryPath(t) : null;
      process.stdout.write(JSON.stringify({ state: bin ? "ready" : "missing", path: bin }));
      return;
    }
    process.stdout.write(readFileSync(p, "utf8"));
  } catch {
    process.stdout.write(JSON.stringify({ state: "unknown" }));
  }
}

const mode = process.argv[2];
if (mode === "--status") {
  status();
} else {
  ensure().catch((e) => {
    process.stderr.write(`[ensure-host] ${e instanceof Error ? e.message : e}\n`);
    writeStatus({ state: "failed", error: e instanceof Error ? e.message : String(e) });
  });
}

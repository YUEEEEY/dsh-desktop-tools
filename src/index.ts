// dsh-desktop-tools —— dsh 环境管理插件（纯插件，无桌面壳依赖）
//
// 提供（注册在 dsh web profile 的 HTTP 路由上）：
//   /panel            综合面板（运行时版本 / 更新 / 补丁 / 计费摘要）
//   /billing          计费页（余额 + 全部会话 token 用量 + 估算花费）
//   /api/runtime      GET 状态 / POST 触发后台更新（npm install）
//   /api/runtime/log  更新日志尾部 + 是否仍在运行
//   /api/patches      GET 状态 / POST 重新应用 Windows 补丁
//   /api/billing      计费 JSON
//
// 安装方式（无壳，dsh 原生插件）：
//   dsh plugin --profile web add file:<本包目录>   # 本地/仓库内引用
//   或发布到 npm / git 后：dsh plugin --profile web add dsh-desktop-tools
//
// 运行时定位顺序（补丁/更新目标）：
//   1) 环境变量 DSH_RUNTIME_DIR（桌面壳兼容模式，显式指定运行时）
//   2) 当前正在运行的 dsh 实例（process.argv[1] → <安装>/lib/bin.js）
//   3) npm 全局安装的 @deepseek-ai/dsh
//   4) 插件自身所在运行时的目录上溯
// 无法定位时，补丁与更新功能报告“未定位到 dsh 安装”，其余照常。

import {
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  statSync,
  readSync,
  writeSync,
  closeSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { execFile, execFileSync, spawn } from "node:child_process";
import z from "@deepseek-ai/schemastery";

const name = "desktop-tools";
const inject = ["webServer", "cmdlineArgs"];

const Config = z.object({
  /** 插件加载时自动重打 Windows 补丁（幂等），默认开启 */
  autoApplyPatches: z.boolean().default(true),
  /** 加载时异步检查 dsh 最新版本，发现新版时打印提示（可在面板手动更新），默认开启 */
  checkUpdatesOnLaunch: z.boolean().default(true),
  /** 运行时更新方式：auto（有 DSH_RUNTIME_DIR 用 --prefix，否则用 -g 全局）/ global / prefix */
  updateMode: z
    .union([z.const("auto"), z.const("global"), z.const("prefix")])
    .default("auto"),
  /** 桌面窗口宿主二进制路径（Rust/Tauri 编译产物 dsh-desktop.exe）；留空自动定位（插件内嵌 → 仓库构建 → PATH） */
  desktopBin: z.string().default(""),
  /** dsh web 启动后自动打开桌面端窗口（可用 `dsh web --no-desktop` 关闭），默认开启 */
  autoOpenDesktop: z.boolean().default(true),
  /** 估算单价（¥/百万 tokens），默认按 DeepSeek-V4-Flash 官方空闲时段价 */
  prices: z
    .object({
      input: z.number().default(1.5),
      cacheRead: z.number().default(0.05),
      cacheWrite: z.number().default(0),
      output: z.number().default(4.5),
    })
    .default({ input: 1.5, cacheRead: 0.05, cacheWrite: 0, output: 4.5 }),
});

/* ---------------- 平台辅助 ---------------- */

const IS_WIN = process.platform === "win32";
/** npm 命令名（Windows 为 npm.cmd） */
const NPM_BIN = IS_WIN ? "npm.cmd" : "npm";
/** 宿主二进制平台目录（插件包 desktop/<platform>-<arch>/） */
function hostPlatformDir() {
  const p = process.platform;
  const a = process.arch;
  if (p === "win32") return "win32-x64";
  if (p === "darwin") return a === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (p === "linux") return a === "arm64" ? "linux-arm64" : "linux-x64";
  return `${p}-${a}`;
}
/** 跨平台执行 shell 命令（win32 用 cmd /C，unix 用 sh -c），返回子进程 */
function shellRun(cmd, opts = {}) {
  if (IS_WIN) return spawn("cmd", ["/C", cmd], opts);
  return spawn("sh", ["-c", cmd], opts);
}

/* ---------------- 定位 ---------------- */

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/** 本包根目录（…/node_modules/dsh-desktop-tools） */
function pluginRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/** 运行时根目录（内含 node_modules/@deepseek-ai/dsh/package.json） */
function runtimeRoot() {
  // 1) 壳兼容模式：环境变量 DSH_RUNTIME_DIR 显式指定运行时
  const fromEnv = process.env.DSH_RUNTIME_DIR;
  if (
    fromEnv &&
    existsSync(join(fromEnv, "node_modules", "@deepseek-ai", "dsh", "package.json"))
  ) {
    return fromEnv;
  }
  // 2) 无壳模式：当前正在运行的 dsh 实例（process.argv[1] = <安装>/lib/bin.js）
  const self = currentDshInstall();
  if (self) return self;
  // 3) npm 全局安装的 dsh
  const globalRoot = npmGlobalRoot();
  if (
    globalRoot &&
    existsSync(join(globalRoot, "node_modules", "@deepseek-ai", "dsh", "package.json"))
  ) {
    return globalRoot;
  }
  // 4) 插件位于 <runtime>/node_modules/dsh-desktop-tools/lib 时上溯四层
  const walk = join(pluginRoot(), "..", "..", "..");
  if (existsSync(join(walk, "node_modules", "@deepseek-ai", "dsh", "package.json"))) {
    return walk;
  }
  return undefined;
}

/** 无壳模式：定位当前正在运行的 dsh 安装（启动脚本 <prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js → <prefix>） */
function currentDshInstall() {
  const entry = process.argv[1];
  if (!entry) return undefined;
  const abs = resolve(entry);
  // 上溯 2 级 = dsh 包目录（<prefix>/node_modules/@deepseek-ai/dsh）
  const pkgDir = dirname(dirname(abs));
  try {
    const p = join(pkgDir, "package.json");
    if (!existsSync(p)) return undefined;
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j.name !== "@deepseek-ai/dsh") return undefined;
  } catch {
    return undefined;
  }
  // 再上溯：@deepseek-ai → node_modules → <prefix>（运行时根，含 node_modules/@deepseek-ai/dsh）
  const root = dirname(dirname(dirname(pkgDir)));
  if (existsSync(join(root, "node_modules", "@deepseek-ai", "dsh", "package.json"))) {
    return root;
  }
  return undefined;
}

/** npm 全局前缀目录（npm root -g 的父级），结果缓存 */
let globalRootCache = undefined;
function npmGlobalRoot() {
  if (globalRootCache !== undefined) return globalRootCache;
  try {
    const out = execFileSync(NPM_BIN, ["root", "-g"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      shell: IS_WIN,
    });
    const line = String(out).trim().split(/\r?\n/)[0] || "";
    globalRootCache = line ? dirname(line) : undefined;
  } catch {
    globalRootCache = undefined;
  }
  return globalRootCache;
}

function resolveRuntimePkg(pkg) {
  const root = runtimeRoot();
  if (!root) return undefined;
  const seg = pkg.split("/");
  const hoisted = join(root, "node_modules", ...seg);
  if (existsSync(join(hoisted, "package.json"))) return hoisted;
  const nested = join(
    root,
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "node_modules",
    ...seg,
  );
  if (existsSync(join(nested, "package.json"))) return nested;
  return undefined;
}

function installedVersion() {
  const root = runtimeRoot();
  if (!root) return undefined;
  try {
    const p = join(root, "node_modules", "@deepseek-ai", "dsh", "package.json");
    return JSON.parse(readFileSync(p, "utf8")).version;
  } catch {
    return undefined;
  }
}

/* npm view 为网络请求，异步执行并缓存 60s，避免阻塞 Harness 事件循环 */
const latestCache = { value: undefined, at: 0, fetching: false };

function fetchLatestVersionAsync() {
  if (latestCache.fetching) return;
  latestCache.fetching = true;
  execFile(
    NPM_BIN,
    [
      "view",
      "@deepseek-ai/dsh",
      "version",
      "--no-audit",
      "--no-fund",
      "--fetch-retries=0",
      "--fetch-timeout=8000",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15000, shell: IS_WIN },
    (error, stdout) => {
      latestCache.fetching = false;
      if (error) return;
      const line = String(stdout ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("npm warn"));
      if (line) {
        latestCache.value = line;
        latestCache.at = Date.now();
      }
    },
  );
}

function latestVersion() {
  if (Date.now() - latestCache.at > 60000) fetchLatestVersionAsync();
  return latestCache.value;
}

/** 简单语义化版本比较：a > b（处理 x.y.z-rc.N 预发布） */
function isNewer(a, b) {
  const split = (v) => {
    const i = v.indexOf("-");
    return i >= 0 ? [v.slice(0, i), v.slice(i + 1)] : [v, null];
  };
  const nums = (v) =>
    (v || "0").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [coreA, preA] = split(a);
  const [coreB, preB] = split(b);
  const pa = nums(coreA);
  const pb = nums(coreB);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  if (preA === null && preB !== null) return true; // 正式版 > 预发布
  if (preA !== null && preB === null) return false;
  if (preA === null) return false; // 完全相同
  const na = nums(preA);
  const nb = nums(preB);
  const m = Math.max(na.length, nb.length);
  for (let i = 0; i < m; i++) {
    const x = na[i] || 0;
    const y = nb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function runtimeStatus() {
  const root = runtimeRoot();
  const installed = installedVersion();
  const latest = latestVersion();
  const updateAvailable =
    installed !== undefined && latest !== undefined && isNewer(latest, installed);
  return {
    runtimeDir: root || null,
    installed,
    latest,
    latestFetching: latestCache.fetching,
    updateAvailable,
    dshHome: dshHome(),
  };
}

/* ---------------- Windows 补丁 ---------------- */

const WINDOWS_INSPECTOR_SOURCE = `var WindowsProcessInspector = class {
	constructor(internals) {
		this.internals = internals;
	}
	signalGroup(_pgid, _signal) {}
	signalProcess(identity, signal) {
		if (this.isAlive(identity)) {
			try {
				this.internals.kill(identity.pid, signal);
			} catch (_alreadyGone) {}
		}
	}
	foregroundPgid(_shellPid) {
		return void 0;
	}
	isStdinWaiting(_pgid) {
		return false;
	}
	processTree(rootPid) {
		return processTree(this.processTable(), rootPid);
	}
	processSession(_sessionId) {
		return [];
	}
	isAlive(identity) {
		return this.processTable().some((entry) => entry.pid === identity.pid && entry.started === identity.started);
	}
	processTable() {
		try {
			const out = this.internals.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.Ticks }"]);
			const entries = [];
			for (const line of out.split(/\\r?\\n/)) {
				const match = /^(\\d+)\\|(\\d+)\\|(\\d+)$/.exec(line.trim());
				if (match !== void 0 && match[1] !== void 0 && match[2] !== void 0 && match[3] !== void 0) {
					entries.push({ pid: Number(match[1]), parentPid: Number(match[2]), started: match[3] });
				}
			}
			return entries;
		} catch (_unavailable) {
			return [];
		}
	}
};`;

const SUBPROCESS_OLD_THROW =
  "\tthrow new Error(`subprocess-local: terminal inspection is unsupported on platform ${platform}`);";
const SUBPROCESS_NEW_THROW =
  '\tif (platform === "win32") return new WindowsProcessInspector(internals);\n' +
  SUBPROCESS_OLD_THROW;

function subprocessCheck() {
  const pkg = resolveRuntimePkg("@deepseek-ai/dsh-subprocess-local");
  if (!pkg) {
    return {
      ok: false,
      detail: "未定位到 dsh-subprocess-local（无法定位 dsh 安装或运行时布局不匹配）",
    };
  }
  const file = join(pkg, "lib", "index.js");
  try {
    const content = readFileSync(file, "utf8");
    if (content.includes("WindowsProcessInspector")) {
      return { ok: true, detail: "已打过 win32 补丁" };
    }
    return {
      ok: false,
      detail: "未应用（缺少 WindowsProcessInspector）",
      file,
      content,
    };
  } catch (e) {
    return { ok: false, detail: `读取失败：${e.message}` };
  }
}

function patchSubprocessWin32() {
  if (!IS_WIN) return { ok: true, detail: "非 Windows 平台，无需补丁" };
  const st = subprocessCheck();
  if (st.ok) return st;
  if (!st.file || !st.content) return st;
  if (!st.content.includes("function createProcessInspector")) {
    return { ok: false, detail: "未找到 createProcessInspector（dsh 版本可能已变化）" };
  }
  if (!st.content.includes(SUBPROCESS_OLD_THROW)) {
    return { ok: false, detail: "未找到 throw 分支（dsh 版本可能已变化）" };
  }
  const withClass = st.content.replace(
    "function createProcessInspector",
    `${WINDOWS_INSPECTOR_SOURCE}\nfunction createProcessInspector`,
  );
  const patched = withClass.replace(SUBPROCESS_OLD_THROW, SUBPROCESS_NEW_THROW);
  try {
    writeFileSync(st.file, patched, "utf8");
  } catch (e) {
    return { ok: false, detail: `写入失败：${e.message}` };
  }
  return { ok: true, detail: "win32 进程检查器补丁已应用" };
}

const MINIMAL_EDITS = [
  [
    "      name: '@deepseek-ai/dsh-terminal'\n",
    "      name: '@deepseek-ai/dsh-terminal'\n      disabled: !!js process.platform === 'win32'\n",
  ],
  [
    "      name: '@deepseek-ai/dsh-terminal-bash'\n",
    "      name: '@deepseek-ai/dsh-terminal-bash'\n      disabled: !!js process.platform === 'win32'\n",
  ],
  [
    "      name: '@deepseek-ai/dsh-tool-bash-persistent'\n",
    "      name: '@deepseek-ai/dsh-tool-bash-persistent'\n      disabled: !!js process.platform === 'win32'\n",
  ],
  [
    "          * Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.\n",
    "          * Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.\n\n    - id: persistent-pwsh\n      name: '@deepseek-ai/dsh-tool-pwsh'\n      disabled: !!js process.platform !== 'win32'\n",
  ],
];

function minimalPresetCheck() {
  const root = runtimeRoot();
  if (!root) {
    return { ok: false, detail: "未定位到 dsh 安装" };
  }
  const file = join(
    root,
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "config",
    "agent-presets",
    "minimal",
    "agent.cordis.yml",
  );
  try {
    const content = readFileSync(file, "utf8");
    if (content.includes("persistent-pwsh")) {
      return { ok: true, detail: "已打过 minimal preset 补丁" };
    }
    return { ok: false, detail: "未应用（缺少 persistent-pwsh）", file, content };
  } catch (e) {
    return { ok: false, detail: `读取失败：${e.message}` };
  }
}

function patchMinimalPresetWin32() {
  if (!IS_WIN) return { ok: true, detail: "非 Windows 平台，无需补丁" };
  const st = minimalPresetCheck();
  if (st.ok) return st;
  if (!st.file || !st.content) return st;
  let patched = st.content;
  for (const [oldText, newText] of MINIMAL_EDITS) {
    if (!patched.includes(oldText)) {
      return { ok: false, detail: `minimal preset 未找到匹配片段：${oldText.trim()}` };
    }
    patched = patched.replace(oldText, newText);
  }
  try {
    writeFileSync(st.file, patched, "utf8");
  } catch (e) {
    return { ok: false, detail: `写入失败：${e.message}` };
  }
  return { ok: true, detail: "minimal preset win32 补丁已应用（bash 持久终端 → pwsh 工具）" };
}

function patchesStatus() {
  return [
    {
      id: "subprocess-local",
      name: "subprocess-local win32 进程检查器",
      ...subprocessCheck(),
    },
    { id: "minimal-preset", name: "minimal preset → pwsh 工具", ...minimalPresetCheck() },
  ];
}

function applyPatches() {
  return [
    {
      id: "subprocess-local",
      name: "subprocess-local win32 进程检查器",
      ...patchSubprocessWin32(),
    },
    {
      id: "minimal-preset",
      name: "minimal preset → pwsh 工具",
      ...patchMinimalPresetWin32(),
    },
  ];
}

/* ---------------- 计费 ---------------- */

function deepseekApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  try {
    const text = readFileSync(join(dshHome(), ".credentials.yaml"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^DEEPSEEK_API_KEY:\s*(\S+)\s*$/.exec(line.trim());
      if (m) return m[1];
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function fetchBalance(cb) {
  const key = deepseekApiKey();
  if (!key) return cb({ error: "未找到 DEEPSEEK_API_KEY" });
  execFile(
    "curl.exe",
    [
      "-s",
      "--max-time",
      "15",
      "-H",
      `Authorization: Bearer ${key}`,
      "https://api.deepseek.com/user/balance",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 20000 },
    (error, stdout) => {
      if (error) return cb({ error: String(error?.message ?? error) });
      try {
        const j = JSON.parse(stdout);
        const info = j.balance_infos?.[0];
        cb({
          isAvailable: !!j.is_available,
          currency: info?.currency ?? "CNY",
          totalBalance: Number(info?.total_balance ?? 0),
          grantedBalance: Number(info?.granted_balance ?? 0),
          toppedUpBalance: Number(info?.topped_up_balance ?? 0),
        });
      } catch (e) {
        cb({ error: String(e?.message ?? e) });
      }
    },
  );
}

function fetchUsage() {
  try {
    const pc = join(dshHome(), "storages", "session_projcache.json");
    const j = JSON.parse(readFileSync(pc, "utf8"));
    const sessions = (j.tables?.sessions ?? {}) as Record<
      string,
      { rows?: { tokenUsage?: { val?: { totals?: Record<string, number | undefined> } } } }
    >;
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0 };
    for (const sv of Object.values(sessions)) {
      const totals = sv.rows?.tokenUsage?.val?.totals;
      if (!totals) continue;
      t.input += totals.uncachedInputTokens ?? 0;
      t.output += totals.outputTokens ?? 0;
      t.cacheRead += totals.cacheReadTokens ?? 0;
      t.cacheWrite += totals.cacheWriteTokens ?? 0;
      t.sessions += 1;
    }
    return t;
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

function billingPayload(prices, cb) {
  const u = fetchUsage();
  fetchBalance((balance) => {
    if ("error" in u) return cb({ balance, usage: u });
    const est =
      (u.input / 1e6) * prices.input +
      (u.cacheRead / 1e6) * prices.cacheRead +
      (u.cacheWrite / 1e6) * prices.cacheWrite +
      (u.output / 1e6) * prices.output;
    cb({
      balance,
      usage: u,
      estimatedCost: Math.round(est * 100) / 100,
      prices,
    });
  });
}

/* ---------------- 运行时更新 ---------------- */

let updateChild = null;
/** 运行时更新方式：auto / global / prefix（apply 时从配置设置） */
let updateMode = "auto";

function updateLogPath() {
  // 壳模式：日志放运行时旁；无壳模式：放 DSH_HOME 下
  if (process.env.DSH_RUNTIME_DIR) {
    const root = runtimeRoot();
    if (root) return join(root, "..", "update.log");
  }
  return join(dshHome(), "desktop-tools-update.log");
}

function isUpdateRunning() {
  return updateChild !== null;
}

function startRuntimeUpdate() {
  const root = runtimeRoot();
  if (!root) return { ok: false, error: "未定位到 dsh 安装目录" };
  if (updateChild !== null) {
    return { ok: false, error: "已有一个更新任务在运行" };
  }
  const mode =
    updateMode === "auto"
      ? process.env.DSH_RUNTIME_DIR === root
        ? "prefix"
        : "global"
      : updateMode;
  const log = updateLogPath();
  const dirStr = root.includes(" ") ? `"${root}"` : root;
  const inner =
    mode === "prefix"
      ? `npm install --prefix ${dirStr} @deepseek-ai/dsh@latest --no-audit --no-fund --loglevel=error`
      : `npm install -g @deepseek-ai/dsh@latest --no-audit --no-fund --loglevel=error`;
  const cmd = root.includes(" ") ? `"${inner}"` : inner;
  try {
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(
      log,
      `\n[${new Date().toISOString()}] ${inner} (runtime: ${root})\n`,
    );
    const fd = openSync(log, "a");
    const child = shellRun(cmd, {
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    child.unref();
    updateChild = child;
    child.on("exit", () => {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      updateChild = null;
    });
    return { ok: true, pid: child.pid, log };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

function readLogTail(maxBytes = 4096) {
  const log = updateLogPath();
  try {
    const size = statSync(log).size;
    const start = Math.max(0, size - maxBytes);
    const fd = openSync(log, "r");
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

/* ---------------- 桌面宿主 ---------------- */

let desktopBin = "";
/** 当前 webServer 端口（apply 时从 ctx.webServer 获取），用于桌面窗口连接 */
let currentPort = 3080;

/** 定位 Rust 桌面宿主（dsh-desktop）：
 *  1) Config.desktopBin  2) 环境变量 DSH_DESKTOP_BIN
 *  3) 插件内嵌 <插件包>/desktop/<platform>-<arch>/  4) 仓库内构建 <dsh-env>/host/target/release/
 *  5) PATH */
function desktopHostPath() {
  const exeName = IS_WIN ? "dsh-desktop.exe" : "dsh-desktop";
  const cands = [
    desktopBin,
    process.env.DSH_DESKTOP_BIN,
    join(pluginRoot(), "desktop", hostPlatformDir(), exeName),
    join(pluginRoot(), "..", "..", "..", "host", "target", "release", exeName),
    exeName,
  ];
  for (const c of cands) {
    if (!c) continue;
    if (c.includes("\\") || c.includes("/")) {
      if (existsSync(c)) return c;
    } else {
      return c; // PATH 名
    }
  }
  return undefined;
}

async function desktopStatus() {
  const bin = desktopHostPath();
  const exists = bin ? existsSync(bin) : false;
  return {
    bin: bin || null,
    exists,
    serverUp: await portUp(currentPort),
    hint: exists
      ? "宿主就绪，可打开桌面端"
      : "未找到宿主二进制（请重新安装插件，或在 dsh-env/host 运行 cargo build --release，或设置 desktopBin/DSH_DESKTOP_BIN）",
  };
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

/** 启动桌面窗口宿主（detached，独立 GUI 进程） */
async function startDesktop() {
  const bin = desktopHostPath();
  if (!bin || !existsSync(bin)) {
    return { ok: false, error: "未找到宿主二进制，请重新安装插件（见面板提示）" };
  }
  const up = await portUp(currentPort);
  const args = up
    ? ["--url", `http://127.0.0.1:${currentPort}`]
    : ["--serve", "--port", String(currentPort)];
  if (process.env.DSH_HOME) args.push("--home", process.env.DSH_HOME);
  try {
    const child = spawn(bin, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return { ok: true, bin, args, pid: child.pid };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/* ---------------- 页面 ---------------- */

const BILLING_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DSH 计费</title>
<style>
:root{--bg:#10141c;--card:#1a2030;--border:#2a3348;--text:#e6eaf2;--dim:#8b94a8;--accent:#4dabf7;--green:#38d9a9;--red:#ff6b6b}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:var(--bg);color:var(--text);padding:32px 20px;display:flex;justify-content:center}
.wrap{width:100%;max-width:720px}
h1{font-size:20px;margin-bottom:4px}
.sub{color:var(--dim);font-size:12.5px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px 20px;margin-bottom:14px}
.card h2{font-size:14px;color:var(--dim);font-weight:600;margin-bottom:10px;letter-spacing:.03em}
.big{font-size:30px;font-weight:800;color:var(--green)}
.big .cur{font-size:16px;font-weight:600;color:var(--dim);margin-left:4px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.item{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px 14px}
.item label{display:block;font-size:11px;color:var(--dim);margin-bottom:4px}
.item span{font-size:14px;word-break:break-all}
.note{margin-top:12px;font-size:12px;color:var(--dim);line-height:1.7}
.err{color:var(--red);font-size:13px;margin-top:8px}
.actions{margin:18px 0;display:flex;gap:10px}
button{font:inherit;font-size:13px;padding:9px 16px;border-radius:9px;border:1px solid var(--border);background:#232c40;color:var(--text);cursor:pointer}
button:hover{border-color:var(--accent)}
#time{color:var(--dim);font-size:12px;margin-left:auto;align-self:center}
</style>
</head>
<body>
<div class="wrap">
  <h1>DSH 计费</h1>
  <div class="sub">DeepSeek 官方账户余额 · 全部会话 token 用量 · 估算花费（插件：dsh-desktop-tools）</div>
  <div class="actions">
    <button id="refresh">刷新</button>
    <span id="time"></span>
  </div>
  <div class="card">
    <h2>剩余余额</h2>
    <div class="big" id="balance">加载中…</div>
    <div class="note" id="balanceNote"></div>
  </div>
  <div class="card">
    <h2>已用 tokens（全部会话）</h2>
    <div class="grid">
      <div class="item"><label>输入（未命中缓存）</label><span id="uInput">-</span></div>
      <div class="item"><label>输出</label><span id="uOutput">-</span></div>
      <div class="item"><label>缓存读</label><span id="uCacheRead">-</span></div>
      <div class="item"><label>缓存写</label><span id="uCacheWrite">-</span></div>
      <div class="item"><label>统计会话数</label><span id="uSessions">-</span></div>
      <div class="item"><label>估算已花费</label><span id="cost">-</span></div>
    </div>
    <div class="note" id="usageNote"></div>
  </div>
  <div class="note">估算单价按 DeepSeek-V4-Flash 官方空闲时段价（输入 ¥1.5/百万、缓存命中 ¥0.05/百万、输出 ¥4.5/百万；高峰 9:00-14:00 翻倍）。实际以官方账单为准。</div>
</div>
<script>
const $=(id)=>document.getElementById(id);
const fmt=(n)=>(n??0).toLocaleString('zh-CN');
async function load(){
  try{
    const d=await (await fetch('/api/billing',{cache:'no-store'})).json();
    const b=d.balance;
    if(b&&!b.error){
      $('balance').textContent='¥'+b.totalBalance.toFixed(2)+'<span class="cur">'+b.currency+'</span>';
      $('balance').innerHTML=$('balance').textContent;
      $('balanceNote').textContent='充值 ¥'+b.toppedUpBalance.toFixed(2)+' · 赠送 ¥'+b.grantedBalance.toFixed(2)+(b.isAvailable?'':' · 账户不可用');
    }else{
      $('balance').textContent='无法获取';
      $('balanceNote').textContent='余额：'+(b?.error||'未知');
    }
    const u=d.usage;
    if(u&&!u.error){
      $('uInput').textContent=fmt(u.input);
      $('uOutput').textContent=fmt(u.output);
      $('uCacheRead').textContent=fmt(u.cacheRead);
      $('uCacheWrite').textContent=fmt(u.cacheWrite);
      $('uSessions').textContent=fmt(u.sessions);
      $('cost').textContent='约 ¥'+(d.estimatedCost??0).toFixed(2);
      $('usageNote').textContent='';
    }else{
      $('usageNote').textContent='用量：'+(u?.error||'未知');
    }
    $('time').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN');
  }catch(e){
    $('balance').textContent='请求失败';
    $('balanceNote').textContent=''+e;
  }
}
$('refresh').addEventListener('click',load);
load();
setInterval(load,30000);
</script>
</body>
</html>`;

const PANEL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DSH 环境面板</title>
<style>
:root{--bg:#10141c;--card:#1a2030;--border:#2a3348;--text:#e6eaf2;--dim:#8b94a8;--accent:#4dabf7;--green:#38d9a9;--red:#ff6b6b;--amber:#ffd43b}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:var(--bg);color:var(--text);padding:28px 18px;display:flex;justify-content:center}
.wrap{width:100%;max-width:760px}
h1{font-size:20px;margin-bottom:4px}
.sub{color:var(--dim);font-size:12.5px;margin-bottom:18px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 18px;margin-bottom:14px}
.card h2{font-size:13px;color:var(--dim);font-weight:600;margin-bottom:10px;letter-spacing:.04em;display:flex;align-items:center;gap:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.item{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px 13px}
.item label{display:block;font-size:11px;color:var(--dim);margin-bottom:4px}
.item span{font-size:14px;word-break:break-all}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
button{font:inherit;font-size:13px;padding:8px 14px;border-radius:9px;border:1px solid var(--border);background:#232c40;color:var(--text);cursor:pointer}
button:hover{border-color:var(--accent)}
button:disabled{opacity:.45;cursor:not-allowed}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.badge{font-size:11px;padding:2px 8px;border-radius:20px;border:1px solid var(--border)}
.badge.ok{color:var(--green);border-color:var(--green)}
.badge.bad{color:var(--red);border-color:var(--red)}
.badge.warn{color:var(--amber);border-color:var(--amber)}
.badge.dim{color:var(--dim)}
pre.log{background:#0b0e15;border:1px solid var(--border);border-radius:10px;padding:12px;font-size:12px;line-height:1.6;color:#9aa7c0;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow:auto}
.muted{color:var(--dim);font-size:12px}
.err{color:var(--red);font-size:12.5px;margin-top:6px}
</style>
</head>
<body>
<div class="wrap">
  <h1>DSH 环境面板</h1>
  <div class="sub">插件 dsh-desktop-tools · 运行时管理 / Windows 补丁 / 计费摘要</div>

  <div class="card">
    <h2>dsh 运行时</h2>
    <div class="grid">
      <div class="item"><label>已安装</label><span id="installed">-</span></div>
      <div class="item"><label>最新版本</label><span id="latest">-</span></div>
      <div class="item"><label>状态</label><span id="state">-</span></div>
      <div class="item"><label>DSH_HOME</label><span id="dshHome">-</span></div>
    </div>
    <div class="row" style="margin-top:12px">
      <button id="btnUpdate">更新运行时</button>
      <button id="btnRefresh">刷新状态</button>
      <span class="muted" id="updateHint"></span>
    </div>
    <div class="row" style="margin-top:8px">
      <button id="btnDesktop">打开桌面端</button>
      <span class="muted" id="desktopHint"></span>
    </div>
    <pre class="log" id="upLog" style="margin-top:10px;display:none"></pre>
    <div class="err" id="runtimeErr"></div>
  </div>

  <div class="card">
    <h2>Windows 补丁 <span class="muted">（win32 运行时补丁）</span></h2>
    <div id="patchList"></div>
    <div class="row" style="margin-top:12px">
      <button id="btnPatches">重新应用补丁</button>
      <span class="muted" id="patchHint"></span>
    </div>
  </div>

  <div class="card">
    <h2>计费摘要</h2>
    <div class="grid">
      <div class="item"><label>剩余余额</label><span id="bal">-</span></div>
      <div class="item"><label>估算已花费</label><span id="cost">-</span></div>
      <div class="item"><label>统计会话</label><span id="sessions">-</span></div>
    </div>
    <div class="row" style="margin-top:12px">
      <a href="/billing">打开完整计费页 →</a>
    </div>
  </div>

  <div class="card">
    <h2>关于</h2>
    <div class="muted">
      本面板由 dsh-desktop-tools 插件提供（纯 dsh 插件，无桌面壳依赖）。
      外链（引用 / GitHub 等）会在浏览器新标签页中打开。
    </div>
  </div>
</div>
<script>
const $=(id)=>document.getElementById(id);
const fmt=(n)=>(n??0).toLocaleString('zh-CN');
const stateEl=(ok,text)=>{
  const cls=ok?'ok':(text==='未知'||text==='未定位到 dsh 安装'||text==='-')?'dim':'bad';
  return '<span class="badge '+cls+'">'+text+'</span>';
};
async function loadRuntime(){
  try{
    const d=await (await fetch('/api/runtime',{cache:'no-store'})).json();
    $('installed').textContent=d.installed||'未安装';
    $('latest').textContent=d.latest||'未知';
    $('dshHome').textContent=d.dshHome||'-';
    if(d.updateAvailable){
      $('state').innerHTML=stateEl(false,'可更新');
      $('updateHint').textContent='检测到新版本，可点击“更新运行时”（后台安装，完成后重启 dsh 服务生效）';
    }else if(d.installed&&d.latest){
      $('state').innerHTML=stateEl(true,'已是最新');
      $('updateHint').textContent='';
    }else{
      $('state').innerHTML=stateEl(false,'未知');
      $('updateHint').textContent='latest 获取失败（网络不可用？）或未定位到 dsh 安装：'+(d.runtimeDir||'未定位');
    }
  }catch(e){
    $('runtimeErr').textContent=''+e;
  }
}
async function loadPatches(){
  try{
    const d=await (await fetch('/api/patches',{cache:'no-store'})).json();
    $('patchList').innerHTML=(d.patches||[]).map(p=>
      '<div class="item" style="margin-bottom:8px">'+
        '<div class="row" style="justify-content:space-between"><span>'+p.name+'</span>'+stateEl(p.ok,p.ok?'已应用':'未应用')+'</div>'+
        '<div class="muted" style="margin-top:4px">'+p.detail+'</div>'+
      '</div>').join('')||'<div class="muted">暂无补丁信息</div>';
  }catch(e){
    $('patchList').innerHTML='<div class="err">'+e+'</div>';
  }
}
async function loadBilling(){
  try{
    const d=await (await fetch('/api/billing',{cache:'no-store'})).json();
    const b=d.balance;
    $('bal').textContent=(b&&!b.error)?('¥'+b.totalBalance.toFixed(2)):'无法获取';
    $('cost').textContent='约 ¥'+(d.estimatedCost??0).toFixed(2);
    $('sessions').textContent=(d.usage&&!d.usage.error)?fmt(d.usage.sessions):'-';
  }catch(e){ /* 忽略 */ }
}
async function loadDesktop(){
  try{
    const d=await (await fetch('/api/desktop',{cache:'no-store'})).json();
    $('desktopHint').textContent=d.exists
      ? ('宿主就绪'+(d.serverUp?' · dsh 服务在线':''))
      : (d.hint||'');
  }catch(e){ /* 忽略 */ }
}
async function refresh(){
  await Promise.all([loadRuntime(),loadPatches(),loadBilling(),loadDesktop()]);
}
$('btnRefresh').addEventListener('click',refresh);
$('btnDesktop').addEventListener('click',async()=>{
  $('btnDesktop').disabled=true;
  $('desktopHint').textContent='正在启动桌面窗口…';
  try{
    const d=await (await fetch('/api/desktop',{method:'POST'})).json();
    if(d.ok){ $('desktopHint').textContent='已启动桌面端（pid='+d.pid+'）'; }
    else{ $('desktopHint').textContent='启动失败：'+(d.error||''); }
  }catch(e){ $('desktopHint').textContent='请求失败：'+e; }
  $('btnDesktop').disabled=false;
});
$('btnUpdate').addEventListener('click',async()=>{
  $('btnUpdate').disabled=true;
  $('updateHint').textContent='正在后台安装，请耐心等待（首次需下载依赖）…';
  try{
    const d=await (await fetch('/api/runtime',{method:'POST'})).json();
    if(d.ok){
      $('upLog').style.display='block';
      $('updateHint').textContent='安装已开始（pid='+d.pid+'），日志见下方；完成后请重启 dsh 服务生效。';
      const poll=setInterval(async()=>{
        try{
          const r=await (await fetch('/api/runtime/log',{cache:'no-store'})).json();
          $('upLog').textContent=(r.log||'').split('\\n').slice(-30).join('\\n');
          if(!r.running){ clearInterval(poll); $('btnUpdate').disabled=false; await loadRuntime(); }
        }catch(e){ clearInterval(poll); $('btnUpdate').disabled=false; }
      },2000);
    }else{
      $('updateHint').textContent='启动更新失败：'+(d.error||'');
      $('btnUpdate').disabled=false;
    }
  }catch(e){
    $('updateHint').textContent='请求失败：'+e;
    $('btnUpdate').disabled=false;
  }
});
$('btnPatches').addEventListener('click',async()=>{
  $('btnPatches').disabled=true;
  $('patchHint').textContent='正在应用…';
  try{
    const d=await (await fetch('/api/patches',{method:'POST'})).json();
    $('patchHint').textContent='已应用，重启服务后生效';
    await loadPatches();
  }catch(e){
    $('patchHint').textContent='失败：'+e;
  }
  $('btnPatches').disabled=false;
});
refresh();
setInterval(loadRuntime,30000);
</script>
</body>
</html>`;

/* ---------------- 路由 ---------------- */

function json(res, obj, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

function html(res, body) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function apply(ctx, config) {
  const prices = { input: 1.5, cacheRead: 0.05, cacheWrite: 0, output: 4.5, ...(config.prices ?? {}) };
  updateMode = config.updateMode ?? "auto";
  desktopBin = config.desktopBin ?? "";
  currentPort = ctx.webServer?.port ?? Number(process.env.DSH_DESKTOP_PORT || 3080);

  // 加载即重打补丁（幂等）：minimal 模式 / terminal inspection 在 win32 的缺口
  if (config.autoApplyPatches) {
    try {
      for (const p of applyPatches()) {
        console.log(`[desktop-tools] patch ${p.id}: ${p.ok ? "ok" : "failed"} — ${p.detail}`);
      }
    } catch (e) {
      console.warn(`[desktop-tools] 加载时应用补丁失败：${e.message}`);
    }
  }
  // 预热 npm view 缓存（异步，不阻塞事件循环）
  fetchLatestVersionAsync();
  // 加载时检查新版本并提示（无壳模式下替代桌面壳的"启动时自动检查"）
  if (config.checkUpdatesOnLaunch) {
    setTimeout(() => {
      const installed = installedVersion();
      const latest = latestVersion();
      if (installed && latest && isNewer(latest, installed)) {
        console.log(
          `[desktop-tools] 检测到 dsh 新版本 ${latest}（当前 ${installed}），可在 /panel 面板点击“更新运行时”升级`,
        );
      }
    }, 1500);
  }

  // 桌面端：解析 `dsh web --desktop` / `dsh web --no-desktop` 覆盖 autoOpenDesktop，
  // 服务就绪后自动打开桌面窗口（宿主二进制随插件分发或仓库构建）。
  const cmdline = ctx.cmdlineArgs?.get?.() ?? [];
  let wantDesktop = config.autoOpenDesktop !== false;
  if (cmdline.includes("--no-desktop")) wantDesktop = false;
  if (cmdline.includes("--desktop")) wantDesktop = true;
  if (wantDesktop) {
    const desktopDelay = 2500; // 等服务完全就绪
    setTimeout(() => {
      const bin = desktopHostPath();
      if (!bin || !existsSync(bin)) {
        console.log(
          "[desktop-tools] 已请求打开桌面端，但未找到宿主二进制（dsh-desktop.exe）——请重新安装插件或 cargo build",
        );
        return;
      }
      const port = currentPort;
      const args = ["--url", `http://127.0.0.1:${port}`];
      if (process.env.DSH_HOME) args.push("--home", process.env.DSH_HOME);
      try {
        const child = spawn(bin, args, {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
        console.log(`[desktop-tools] 已打开桌面端窗口（pid=${child.pid}，${args[1]}）`);
      } catch (e) {
        console.warn(`[desktop-tools] 打开桌面端失败：${e.message}`);
      }
    }, desktopDelay);
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/panel",
        handler: async (_req, res) => html(res, PANEL_HTML),
      }),
    "desktop-tools: panel page",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/billing",
        handler: async (_req, res) => html(res, BILLING_HTML),
      }),
    "desktop-tools: billing page",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/api/runtime",
        handler: async (req, res) => {
          if (req.method === "POST") {
            json(res, startRuntimeUpdate());
          } else {
            json(res, runtimeStatus());
          }
        },
      }),
    "desktop-tools: runtime api",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/api/runtime/log",
        handler: async (_req, res) => {
          json(res, { log: readLogTail(), running: isUpdateRunning() });
        },
      }),
    "desktop-tools: update log api",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/api/desktop",
        handler: async (req, res) => {
          if (req.method === "POST") {
            json(res, startDesktop());
          } else {
            desktopStatus().then((s) => json(res, s));
          }
        },
      }),
    "desktop-tools: desktop api",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/api/patches",
        handler: async (req, res) => {
          const patches = req.method === "POST" ? applyPatches() : patchesStatus();
          json(res, { patches });
        },
      }),
    "desktop-tools: patches api",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/api/billing",
        handler: async (_req, res) =>
          billingPayload(prices, (payload) => json(res, payload)),
      }),
    "desktop-tools: billing api",
  );
}

export { Config, apply, inject, name };

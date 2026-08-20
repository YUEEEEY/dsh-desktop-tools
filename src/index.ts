// dsh-desktop-tools —— dsh 环境管理插件（纯插件，无桌面壳依赖）
//
// 提供（注册在 dsh web profile 的 HTTP 路由上）：
//   /panel            环境面板（宿主状态 / 运行时版本与更新 / 平台兼容 / 计费摘要）
//   /billing          计费页（余额 + 全部会话 token 用量 + 估算花费）
//   /editor           代码编辑器（工作区文件浏览 / 编辑，宿主主窗口内打开）
//   /api/runtime      GET 状态 / POST 触发后台更新（npm install）
//   /api/runtime/log  更新日志尾部 + 是否仍在运行
//   /api/patches      GET 平台兼容状态 / POST 重新应用
//   /api/desktop      GET 宿主状态 / POST 打开桌面窗口
//   /api/host/ensure  POST 触发宿主自动获取（Release 下载 / 源码构建）
//   /api/fs/tree|read|write  代码编辑器的文件 API（限定在工作区根内）
//   /api/billing      计费 JSON
//
// 安装方式（无壳，dsh 原生插件）：
//   dsh plugin --profile web add dsh-desktop-tools   # npm / git 均可
//
// 宿主自动获取：安装时（postinstall）与插件加载时（惰性兜底）自动执行
// scripts/ensure-host.mjs —— 优先下载 dsh-desktop-host 最新 Release 对应平台的
// 二进制到 $DSH_HOME/desktop-host/<platform>-<arch>/，无 Release 则 clone 源码
// cargo build --release；全部失败时插件照常工作（仅无桌面窗口）。
//
// 运行时定位顺序（补丁/更新目标）：
//   1) 环境变量 DSH_RUNTIME_DIR（桌面壳兼容模式，显式指定运行时）
//   2) 当前正在运行的 dsh 实例（process.argv[1] → <安装>/lib/bin.js）
//   3) npm 全局安装的 @deepseek-ai/dsh
//   4) 插件自身所在运行时的目录上溯
// 无法定位时，补丁与更新功能报告"未定位到 dsh 安装"，其余照常。

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
  readdirSync,
  readlinkSync,
} from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { execFile, execFileSync, spawn } from "node:child_process";
import z from "@deepseek-ai/schemastery";

const name = "desktop-tools";
const inject = ["webServer", "cmdlineArgs"];

const Config = z.object({
  /** 插件加载时自动重打平台兼容补丁（幂等），默认开启 */
  autoApplyPatches: z.boolean().default(true),
  /** 加载时异步检查 dsh 最新版本，发现新版时打印提示（可在面板手动更新），默认开启 */
  checkUpdatesOnLaunch: z.boolean().default(true),
  /** 运行时更新方式：auto（有 DSH_RUNTIME_DIR 用 --prefix，否则用 -g 全局）/ global / prefix */
  updateMode: z
    .union([z.const("auto"), z.const("global"), z.const("prefix")])
    .default("auto"),
  /** 桌面窗口宿主二进制路径（Rust/Tauri 编译产物 dsh-desktop.exe）；留空自动定位（缓存目录 → 仓库构建 → PATH） */
  desktopBin: z.string().default(""),
  /** 是否自动获取宿主二进制（安装时 / 加载时），默认开启 */
  hostAutoInstall: z.boolean().default(true),
  /** dsh web 启动后自动打开桌面端窗口（可用 `dsh web --no-desktop` 关闭），默认开启 */
  autoOpenDesktop: z.boolean().default(true),
  /** 代码编辑器根目录（缺省为 dsh 工作区 / 当前目录） */
  editorRoot: z.string().default(""),
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
/** 宿主二进制平台目录（与 ensure-host.mjs / 宿主 Release 资产命名一致） */
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

/* ---------------- 平台兼容（Windows 自动适配） ---------------- */

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
      return { ok: true, detail: "已适配" };
    }
    return {
      ok: false,
      detail: "未适配（缺少 WindowsProcessInspector）",
      file,
      content,
    };
  } catch (e) {
    return { ok: false, detail: `读取失败：${e.message}` };
  }
}

function patchSubprocessWin32() {
  if (!IS_WIN) return { ok: true, detail: "非 Windows 平台，无需适配" };
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
  return { ok: true, detail: "已适配（终端与进程检查）" };
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
      return { ok: true, detail: "已适配" };
    }
    return { ok: false, detail: "未适配（缺少 persistent-pwsh）", file, content };
  } catch (e) {
    return { ok: false, detail: `读取失败：${e.message}` };
  }
}

function patchMinimalPresetWin32() {
  if (!IS_WIN) return { ok: true, detail: "非 Windows 平台，无需适配" };
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
  return { ok: true, detail: "已适配（命令工具 → pwsh）" };
}

function patchesStatus() {
  return [
    {
      id: "subprocess-local",
      name: "终端与进程能力",
      ...subprocessCheck(),
    },
    { id: "minimal-preset", name: "命令工具适配", ...minimalPresetCheck() },
  ];
}

function applyPatches() {
  return [
    {
      id: "subprocess-local",
      name: "终端与进程能力",
      ...patchSubprocessWin32(),
    },
    {
      id: "minimal-preset",
      name: "命令工具适配",
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

/* ---------------- 宿主自动获取 ---------------- */

function hostRootDir() {
  return join(dshHome(), "desktop-host");
}

function hostCacheBin() {
  return join(
    hostRootDir(),
    hostPlatformDir(),
    IS_WIN ? "dsh-desktop.exe" : "dsh-desktop",
  );
}

function hostStatusFile() {
  return join(hostRootDir(), "ensure-status.json");
}

/** 读取宿主获取状态（ensure-host.mjs 写入） */
function hostStatus() {
  try {
    const p = hostStatusFile();
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    /* ignore */
  }
  const bin = hostCacheBin();
  if (existsSync(bin)) return { state: "ready", path: bin, source: "已存在" };
  return { state: "missing" };
}

/**
 * 惰性触发宿主获取（后台 detached 进程）。
 * 安装时的 postinstall 已执行过一次；这里是兜底（如 pnpm file: 安装不跑脚本）。
 */
function spawnHostEnsure() {
  const st = hostStatus();
  if (st.state === "ready" || st.state === "running") return st;
  try {
    mkdirSync(hostRootDir(), { recursive: true });
    writeFileSync(
      hostStatusFile(),
      JSON.stringify({ at: new Date().toISOString(), state: "running" }),
      "utf8",
    );
  } catch {
    /* ignore */
  }
  const script = join(pluginRoot(), "scripts", "ensure-host.mjs");
  if (!existsSync(script)) {
    const err = "缺少 scripts/ensure-host.mjs（插件安装不完整）";
    try {
      writeFileSync(hostStatusFile(), JSON.stringify({ state: "failed", error: err }), "utf8");
    } catch {
      /* ignore */
    }
    return { state: "failed", error: err };
  }
  try {
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { state: "running", pid: child.pid };
  } catch (e) {
    return { state: "failed", error: String(e?.message ?? e) };
  }
}

/* ---------------- 桌面宿主 ---------------- */

let desktopBin = "";
/** 当前 webServer 端口（apply 时从 ctx.webServer 获取），用于桌面窗口连接 */
let currentPort = 3080;

/** 定位 Rust 桌面宿主（dsh-desktop）：
 *  1) Config.desktopBin  2) 环境变量 DSH_DESKTOP_BIN
 *  3) 自动获取缓存目录 <DSH_HOME>/desktop-host/<platform>-<arch>/
 *  4) 克隆的宿主源码构建产物 <dsh-env>/host/target/release/  5) PATH
 *  （宿主源码独立仓库：https://github.com/YUEEEEY/dsh-desktop-host，
 *    安装插件时会自动下载/构建对应平台二进制，无需手动处理） */
function desktopHostPath() {
  const exeName = IS_WIN ? "dsh-desktop.exe" : "dsh-desktop";
  const cands = [
    desktopBin,
    process.env.DSH_DESKTOP_BIN,
    hostCacheBin(),
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
  const acq = hostStatus();
  return {
    bin: bin || null,
    exists,
    serverUp: await portUp(currentPort),
    acquisition: acq,
    hint: exists
      ? "宿主就绪，可打开桌面端"
      : acq.state === "running"
        ? "正在自动获取宿主二进制…（Release 下载或源码构建）"
        : acq.state === "failed"
          ? `宿主自动获取失败：${acq.error || ""}。可手动构建后设置 DSH_DESKTOP_BIN，或在面板点击"重新获取宿主"。`
          : "未找到宿主二进制，正在尝试自动获取（也可设置 DSH_DESKTOP_BIN）",
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
    return { ok: false, error: "未找到宿主二进制，请等待自动获取完成或重新安装插件（见面板提示）" };
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

/* ---------------- 代码编辑器：文件 API ---------------- */

let editorRoot = process.cwd();

function resolveInRoot(p) {
  const root = resolve(editorRoot);
  const abs = resolve(root, p);
  if (abs !== root && !abs.startsWith(root + sep)) return undefined;
  return abs;
}

function isBinary(buf) {
  const sample = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
  for (const b of sample) {
    if (b === 0) return true;
  }
  return false;
}

function fsTree(dir) {
  const abs = resolveInRoot(dir || ".");
  if (!abs) return { error: "路径超出工作区根目录" };
  let st;
  try {
    st = statSync(abs);
  } catch (e) {
    return { error: `无法访问：${e.message}` };
  }
  if (!st.isDirectory()) return { error: "不是目录" };
  let names;
  try {
    names = readdirSync(abs);
  } catch (e) {
    return { error: `读取目录失败：${e.message}` };
  }
  const SKIP = new Set([".git", "node_modules", ".dsh", ".cache", "target", "dist"]);
  const entries = [];
  for (const n of names) {
    if (n.startsWith(".") && n !== ".env" && n !== ".env.local") continue;
    if (SKIP.has(n)) continue;
    const full = join(abs, n);
    let isDir = false;
    let size = 0;
    try {
      const s = statSync(full);
      isDir = s.isDirectory();
      size = s.size;
    } catch {
      try {
        const l = readlinkSync(full);
        isDir = l.length > 0 && !l.includes(".");
      } catch {
        continue; // 无法访问的条目（权限/symlink 环）跳过
      }
    }
    entries.push({ name: n, path: full, dir: isDir, size });
    if (entries.length >= 500) break;
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { root: abs, entries };
}

function fsRead(p) {
  const abs = resolveInRoot(p);
  if (!abs) return { error: "路径超出工作区根目录" };
  let st;
  try {
    st = statSync(abs);
  } catch (e) {
    return { error: `无法访问：${e.message}` };
  }
  if (st.isDirectory()) return { error: "这是目录，请选择一个文件" };
  const MAX = 2 * 1024 * 1024;
  if (st.size > MAX) return { error: `文件过大（${(st.size / 1024 / 1024).toFixed(1)} MB，上限 2 MB）` };
  let buf;
  try {
    buf = readFileSync(abs);
  } catch (e) {
    return { error: `读取失败：${e.message}` };
  }
  if (isBinary(buf)) return { error: "二进制文件，无法编辑" };
  return { path: abs, content: buf.toString("utf8"), truncated: false };
}

function fsWrite(p, content) {
  const abs = resolveInRoot(p);
  if (!abs) return { error: "路径超出工作区根目录" };
  try {
    writeFileSync(abs, content, "utf8");
    return { ok: true, path: abs };
  } catch (e) {
    return { error: `写入失败：${e.message}` };
  }
}

/* ---------------- 页面（Zed 风格） ---------------- */

const ZED_CSS = `:root{--bg:#0d0f0f;--raise:#141617;--hover:#191c1c;--border:#232626;--text:#d8dcda;--dim:#7d8580;--faint:#5a615d;--accent:#4d6bfe;--green:#3fb68b;--amber:#d19a3d;--red:#e5534b}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:13.5px;line-height:1.55}
.wrap{max-width:780px;margin:0 auto;padding:28px 20px 48px}
h1{font-size:17px;font-weight:650;letter-spacing:.01em;margin-bottom:2px}
.sub{color:var(--dim);font-size:12px;margin-bottom:22px}
.card{background:var(--raise);border:1px solid var(--border);border-radius:6px;padding:14px 16px;margin-bottom:12px}
.card h2{font-size:11px;color:var(--faint);font-weight:600;letter-spacing:.09em;text-transform:uppercase;margin-bottom:10px;display:flex;align-items:center;gap:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.item{padding:8px 10px;border:1px solid var(--border);border-radius:5px;background:var(--bg)}
.item label{display:block;font-size:10.5px;color:var(--faint);letter-spacing:.05em;margin-bottom:3px}
.item span{font-size:13px;font-variant-numeric:tabular-nums;word-break:break-all}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
button{font:inherit;font-size:12px;padding:6px 12px;border-radius:5px;border:1px solid var(--border);background:var(--hover);color:var(--text);cursor:pointer}
button:hover{border-color:var(--accent)}
button:disabled{opacity:.4;cursor:not-allowed}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.badge{font-size:11px;padding:2px 8px;border-radius:20px;border:1px solid var(--border);color:var(--dim)}
.badge.ok{color:var(--green);border-color:var(--green)}
.badge.bad{color:var(--red);border-color:var(--red)}
.badge.warn{color:var(--amber);border-color:var(--amber)}
.badge.dim{color:var(--faint)}
pre.log{background:#0a0b0b;border:1px solid var(--border);border-radius:5px;padding:10px;font-size:11.5px;line-height:1.6;color:#9aa7a0;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto}
.muted{color:var(--dim);font-size:12px}
.err{color:var(--red);font-size:12.5px;margin-top:6px}
details.tech summary{cursor:pointer;color:var(--faint);font-size:11.5px}
details.tech{margin-top:8px}`;

const BILLING_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DSH 计费</title>
<style>${ZED_CSS}
.big{font-size:30px;font-weight:700;color:var(--green);font-variant-numeric:tabular-nums}
.big .cur{font-size:14px;font-weight:600;color:var(--faint);margin-left:4px}
.note{margin-top:10px;font-size:11.5px;color:var(--faint);line-height:1.7}
#time{color:var(--faint);font-size:11.5px;margin-left:auto;align-self:center}
</style>
</head>
<body>
<div class="wrap">
  <h1>DSH 计费</h1>
  <div class="sub">DeepSeek 官方账户余额 · 全部会话 token 用量 · 估算花费</div>
  <div class="row" style="margin-bottom:12px">
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
      $('balance').textContent='¥'+b.totalBalance.toFixed(2)+' '+b.currency;
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
<style>${ZED_CSS}</style>
</head>
<body>
<div class="wrap">
  <h1>DSH 环境面板</h1>
  <div class="sub">插件 dsh-desktop-tools · 宿主状态 / 运行时管理 / 平台兼容 / 计费摘要</div>

  <div class="card">
    <h2>dsh 运行时</h2>
    <div class="grid">
      <div class="item"><label>已安装</label><span id="installed">-</span></div>
      <div class="item"><label>最新版本</label><span id="latest">-</span></div>
      <div class="item"><label>状态</label><span id="state">-</span></div>
      <div class="item"><label>DSH_HOME</label><span id="dshHome">-</span></div>
    </div>
    <div class="row" style="margin-top:10px">
      <button id="btnUpdate">更新运行时</button>
      <button id="btnRefresh">刷新状态</button>
      <span class="muted" id="updateHint"></span>
    </div>
    <pre class="log" id="upLog" style="margin-top:8px;display:none"></pre>
    <div class="err" id="runtimeErr"></div>
  </div>

  <div class="card">
    <h2>桌面宿主</h2>
    <div class="grid">
      <div class="item"><label>状态</label><span id="hostState">-</span></div>
      <div class="item"><label>二进制</label><span id="hostBin">-</span></div>
    </div>
    <div class="row" style="margin-top:10px">
      <button id="btnDesktop">打开桌面端</button>
      <button id="btnEnsure">重新获取宿主</button>
      <span class="muted" id="desktopHint"></span>
    </div>
    <div class="muted" style="margin-top:6px">代码编辑器：宿主菜单 / 托盘「打开代码编辑器」，或 <b>Ctrl+Shift+E</b>（主窗口内打开）</div>
  </div>

  <div class="card">
    <h2>平台兼容（Windows）<span class="muted">自动适配，无需干预</span></h2>
    <div class="row" style="margin-bottom:6px">
      <span class="badge" id="compatBadge">-</span>
      <span class="muted" id="compatHint"></span>
    </div>
    <details class="tech">
      <summary>诊断详情</summary>
      <div id="patchList" style="margin-top:8px"></div>
      <div class="row" style="margin-top:8px">
        <button id="btnPatches">重新应用</button>
        <span class="muted" id="patchHint"></span>
      </div>
    </details>
  </div>

  <div class="card">
    <h2>计费摘要</h2>
    <div class="grid">
      <div class="item"><label>剩余余额</label><span id="bal">-</span></div>
      <div class="item"><label>估算已花费</label><span id="cost">-</span></div>
      <div class="item"><label>统计会话</label><span id="sessions">-</span></div>
    </div>
    <div class="row" style="margin-top:10px">
      <a href="/billing">打开完整计费页 →</a>
    </div>
  </div>

  <div class="card">
    <h2>关于</h2>
    <div class="muted">
      本面板由 dsh-desktop-tools 插件提供（纯 dsh 插件，无桌面壳依赖）。外链（引用 / GitHub 等）会在浏览器新标签页中打开。
    </div>
  </div>
</div>
<script>
const $=(id)=>document.getElementById(id);
const fmt=(n)=>(n??0).toLocaleString('zh-CN');
const badge=(ok,text)=>{
  const cls=ok?'ok':(text==='未知'||text==='-'||text==='missing')?'dim':'bad';
  return '<span class="badge '+cls+'">'+text+'</span>';
};
async function loadRuntime(){
  try{
    const d=await (await fetch('/api/runtime',{cache:'no-store'})).json();
    $('installed').textContent=d.installed||'未安装';
    $('latest').textContent=d.latest||'未知';
    $('dshHome').textContent=d.dshHome||'-';
    if(d.updateAvailable){
      $('state').innerHTML=badge(false,'可更新');
      $('updateHint').textContent='检测到新版本，可点击"更新运行时"（后台安装，完成后重启 dsh 服务生效）';
    }else if(d.installed&&d.latest){
      $('state').innerHTML=badge(true,'已是最新');
      $('updateHint').textContent='';
    }else{
      $('state').innerHTML=badge(false,'未知');
      $('updateHint').textContent='latest 获取失败（网络不可用？）或未定位到 dsh 安装：'+(d.runtimeDir||'未定位');
    }
  }catch(e){ $('runtimeErr').textContent=''+e; }
}
async function loadHost(){
  try{
    const d=await (await fetch('/api/desktop',{cache:'no-store'})).json();
    const a=d.acquisition||{state:d.exists?'ready':'missing'};
    if(a.state==='ready'){ $('hostState').innerHTML=badge(true,'已就绪'); }
    else if(a.state==='running'){ $('hostState').innerHTML=badge(false,'获取中…'); }
    else if(a.state==='failed'){ $('hostState').innerHTML=badge(false,'获取失败'); }
    else { $('hostState').innerHTML=badge(false,'未获取'); }
    $('hostBin').textContent=d.bin||'-';
    $('desktopHint').textContent=d.hint||'';
  }catch(e){ /* 忽略 */ }
}
async function loadPatches(){
  try{
    const d=await (await fetch('/api/patches',{cache:'no-store'})).json();
    const list=d.patches||[];
    const allOk=list.length>0&&list.every(p=>p.ok);
    $('compatBadge').className='badge '+(allOk?'ok':'bad');
    $('compatBadge').textContent=allOk?'已就绪':'需手动处理';
    $('compatHint').textContent=allOk?'Windows 下自动适配终端/进程与命令工具，非 Windows 平台自动跳过。':'部分适配未生效，可在下方"重新应用"或查看诊断。';
    $('patchList').innerHTML=list.map(p=>
      '<div class="item" style="margin-bottom:6px">'+
        '<div class="row" style="justify-content:space-between"><span>'+p.name+'</span>'+badge(p.ok,p.ok?'已适配':'未适配')+'</div>'+
        '<div class="muted" style="margin-top:2px">'+p.detail+'</div>'+
      '</div>').join('')||'<div class="muted">暂无信息</div>';
  }catch(e){ $('patchList').innerHTML='<div class="err">'+e+'</div>'; }
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
async function refresh(){ await Promise.all([loadRuntime(),loadHost(),loadPatches(),loadBilling()]); }
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
$('btnEnsure').addEventListener('click',async()=>{
  $('btnEnsure').disabled=true;
  $('desktopHint').textContent='正在后台获取宿主…';
  try{
    const d=await (await fetch('/api/host/ensure',{method:'POST'})).json();
    $('desktopHint').textContent=(d.state==='running')?'已开始获取（Release 下载或源码构建），稍后刷新查看状态':(d.error||d.state);
  }catch(e){ $('desktopHint').textContent='请求失败：'+e; }
  $('btnEnsure').disabled=false;
  setTimeout(loadHost,3000);
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
    await (await fetch('/api/patches',{method:'POST'})).json();
    $('patchHint').textContent='已应用，重启服务后生效';
    await loadPatches();
  }catch(e){ $('patchHint').textContent='失败：'+e; }
  $('btnPatches').disabled=false;
});
refresh();
setInterval(loadRuntime,30000);
</script>
</body>
</html>`;

const EDITOR_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DSH 代码编辑器</title>
<style>${ZED_CSS}
body{margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden}
#toolbar{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--border);background:var(--raise);flex:none}
#toolbar .root{font-size:12px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40vw}
#toolbar .spacer{flex:1}
#status{font-size:11.5px;color:var(--faint)}
#main{flex:1;display:flex;min-height:0}
#tree{width:250px;flex:none;overflow:auto;border-right:1px solid var(--border);background:var(--bg);padding:6px 0;font-size:12.5px}
#tree .node{padding:3px 10px;cursor:pointer;display:flex;gap:6px;align-items:center;white-space:nowrap;user-select:none}
#tree .node:hover{background:var(--hover)}
#tree .node.dir .caret{display:inline-block;width:10px;color:var(--faint)}
#tree .node.dir.open .caret{transform:rotate(90deg)}
#tree .node.active{background:#1b1e2a}
#tree .node .nm{overflow:hidden;text-overflow:ellipsis}
#tree .node.dir>.nm{color:var(--text)}
#tree .children{padding-left:14px}
#editorPane{flex:1;min-width:0;display:flex;flex-direction:column}
#editorHost{flex:1;min-height:0}
#editorHost .fallback{width:100%;height:100%;background:#0a0b0b;color:var(--text);border:none;padding:12px;font:12.5px/1.6 Consolas,"Cascadia Mono",monospace;resize:none;outline:none}
#empty{display:flex;align-items:center;justify-content:center;height:100%;color:var(--faint);font-size:12.5px}
button{font:inherit;font-size:12px;padding:5px 10px;border-radius:5px;border:1px solid var(--border);background:var(--hover);color:var(--text);cursor:pointer}
button:hover{border-color:var(--accent)}
#err{color:var(--red);font-size:12px;padding:4px 14px;background:var(--raise);border-top:1px solid var(--border);display:none}
</style>
</head>
<body>
<div id="toolbar">
  <button id="back">← 返回主界面</button>
  <span class="root" id="rootLabel">/</span>
  <span class="spacer"></span>
  <button id="refreshTree">刷新</button>
  <span id="status"></span>
</div>
<div id="main">
  <div id="tree"></div>
  <div id="editorPane">
    <div id="editorHost"><div id="empty">从左侧选择一个文件，或 Ctrl+S 保存修改</div></div>
  </div>
</div>
<div id="err"></div>
<script>
const $=(id)=>document.getElementById(id);
let current=null;
let monacoReady=false;
let editor=null;
let fallback=null;

const LANG={
  js:'javascript',mjs:'javascript',cjs:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',
  json:'json',jsonc:'json',md:'markdown',html:'html',htm:'html',css:'css',scss:'scss',less:'less',
  py:'python',rs:'rust',go:'go',java:'java',c:'c',h:'c',cpp:'cpp',hpp:'cpp',cs:'csharp',
  yml:'yaml',yaml:'yaml',toml:'ini',ini:'ini',sh:'shell',bash:'shell',ps1:'powershell',
  sql:'sql',xml:'xml',vue:'html',svelte:'html',txt:'plaintext',log:'plaintext'
};
const langOf=(name)=>{const i=name.lastIndexOf('.');if(i<0)return 'plaintext';return LANG[name.slice(i+1).toLowerCase()]||'plaintext';};

function setStatus(t){$('status').textContent=t;}
function showErr(t){const e=$('err');e.textContent=t;e.style.display=t?'block':'none';}

/* ---------- Monaco（CDN 按需加载，失败降级 textarea） ---------- */
function loadMonaco(){
  return new Promise((resolve)=>{
    if(window.monaco){resolve(true);return;}
    const timeout=setTimeout(()=>{resolve(false);},6000);
    const link=document.createElement('link');
    link.rel='stylesheet';
    link.href='https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs/editor/editor.main.min.css';
    document.head.appendChild(link);
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs/loader.js';
    s.onload=()=>{
      require.config({paths:{vs:'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs'}});
      require(['vs/editor/editor.main'],()=>{clearTimeout(timeout);resolve(true);});
    };
    s.onerror=()=>{clearTimeout(timeout);resolve(false);};
    document.head.appendChild(s);
  });
}

/* ---------- 文件树 ---------- */
async function loadDir(dir, container, level){
  let data;
  try{
    const r=await fetch('/api/fs/tree?dir='+encodeURIComponent(dir),{cache:'no-store'});
    data=await r.json();
  }catch(e){showErr('加载目录失败：'+e);return;}
  if(data.error){showErr(data.error);return;}
  container.innerHTML='';
  for(const it of data.entries){
    const row=document.createElement('div');
    row.className='node'+(it.dir?' dir':'');
    if(it.dir){
      row.innerHTML='<span class="caret">▸</span><span class="nm">'+esc(it.name)+'</span>';
      const child=document.createElement('div');
      child.className='children';
      child.style.display='none';
      row.addEventListener('click',(e)=>{
        e.stopPropagation();
        const open=child.style.display!=='none';
        child.style.display=open?'none':'block';
        row.classList.toggle('open',!open);
        if(!open&&!child.dataset.loaded){child.dataset.loaded='1';loadDir(it.path,child,level+1);}
      });
      container.appendChild(row);
      container.appendChild(child);
    }else{
      row.innerHTML='<span class="nm">'+esc(it.name)+'</span>';
      row.title=it.name+'  ·  '+(it.size/1024).toFixed(1)+' KB';
      row.addEventListener('click',()=>openFile(it.path));
      container.appendChild(row);
    }
  }
}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

/* ---------- 打开 / 保存 ---------- */
async function openFile(path){
  showErr('');
  let data;
  try{
    const r=await fetch('/api/fs/read?path='+encodeURIComponent(path),{cache:'no-store'});
    data=await r.json();
  }catch(e){showErr('读取失败：'+e);return;}
  if(data.error){showErr(data.error);return;}
  current=path;
  setStatus('编辑：'+path);
  document.querySelectorAll('#tree .node.active').forEach(n=>n.classList.remove('active'));
  const host=$('editorHost');
  if(monacoReady&&editor){
    editor.setModel(monaco.editor.createModel(data.content,langOf(path)));
    editor.focus();
  }else{
    if(!fallback){
      fallback=document.createElement('textarea');
      fallback.className='fallback';
      host.appendChild(fallback);
    }
    fallback.value=data.content;
    fallback.focus();
  }
}
async function saveFile(){
  if(!current)return;
  const content=monacoReady&&editor?editor.getValue():(fallback?fallback.value:'');
  setStatus('保存中…');
  try{
    const r=await fetch('/api/fs/write',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:current,content})});
    const d=await r.json();
    if(d.error){showErr(d.error);setStatus('保存失败');}
    else{setStatus('已保存 '+current);setTimeout(()=>setStatus(''),1500);}
  }catch(e){showErr('保存失败：'+e);setStatus('');}
}

/* ---------- 初始化 ---------- */
(async()=>{
  $('back').addEventListener('click',()=>{location.href='/';});
  $('refreshTree').addEventListener('click',()=>loadDir('',$('tree'),0));
  document.addEventListener('keydown',(e)=>{
    if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();saveFile();}
    if((e.ctrlKey||e.metaKey)&&e.key==='b'){e.preventDefault();location.href='/';}
  });
  const root=await (await fetch('/api/fs/tree?dir=.',{cache:'no-store'})).json();
  if(root.error){showErr(root.error);}
  else{
    $('rootLabel').textContent=root.root;
    loadDir(root.root,$('tree'),0);
  }
  const ok=await loadMonaco();
  if(ok){
    monacoReady=true;
    require(['vs/editor/editor.main'],()=>{
      editor=monaco.editor.create($('editorHost'),{
        theme:'vs-dark',
        automaticLayout:true,
        fontSize:13,
        minimap:{enabled:false},
        scrollBeyondLastLine:false,
        renderWhitespace:'none'
      });
      monaco.editor.setTheme('vs-dark');
    });
  }else{
    setStatus('Monaco 加载失败（离线？），已使用内置编辑器');
  }
})();
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

function readBody(req, maxBytes = 16 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function qs(req) {
  try {
    return new URL(req.url ?? "/", "http://x").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function apply(ctx, config) {
  const prices = { input: 1.5, cacheRead: 0.05, cacheWrite: 0, output: 4.5, ...(config.prices ?? {}) };
  updateMode = config.updateMode ?? "auto";
  desktopBin = config.desktopBin ?? "";
  editorRoot = resolve(config.editorRoot || process.cwd());
  currentPort = ctx.webServer?.port ?? Number(process.env.DSH_DESKTOP_PORT || 3080);

  // 加载即重打平台兼容补丁（幂等）：Windows 下自动适配终端/进程与命令工具
  if (config.autoApplyPatches) {
    try {
      for (const p of applyPatches()) {
        console.log(`[desktop-tools] platform-compat ${p.id}: ${p.ok ? "ok" : "failed"} — ${p.detail}`);
      }
    } catch (e) {
      console.warn(`[desktop-tools] 加载时应用平台兼容补丁失败：${e.message}`);
    }
  }
  // 惰性兜底：确保宿主二进制可用（安装时的 postinstall 通常已执行）
  if (config.hostAutoInstall !== false) {
    setTimeout(() => {
      const r = spawnHostEnsure();
      if (r.state === "running") {
        console.log("[desktop-tools] 正在后台获取宿主二进制…");
      } else if (r.state === "failed") {
        console.warn(`[desktop-tools] 宿主自动获取未启动：${r.error}`);
      }
    }, 600);
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
          `[desktop-tools] 检测到 dsh 新版本 ${latest}（当前 ${installed}），可在 /panel 面板点击"更新运行时"升级`,
        );
      }
    }, 1500);
  }

  // 桌面端：解析 `dsh web --desktop` / `dsh web --no-desktop` 覆盖 autoOpenDesktop，
  // 服务就绪后自动打开桌面窗口（宿主由插件自动获取）。
  const cmdline = ctx.cmdlineArgs?.get?.() ?? [];
  let wantDesktop = config.autoOpenDesktop !== false;
  if (cmdline.includes("--no-desktop")) wantDesktop = false;
  if (cmdline.includes("--desktop")) wantDesktop = true;
  if (wantDesktop) {
    const desktopDelay = 2500; // 等服务完全就绪
    setTimeout(() => {
      const bin = desktopHostPath();
      if (!bin || !existsSync(bin)) {
        const st = hostStatus();
        console.log(
          st.state === "running"
            ? "[desktop-tools] 已请求打开桌面端，宿主正在后台获取中（稍后可在 /panel 手动打开）"
            : "[desktop-tools] 已请求打开桌面端，但未找到宿主二进制——请重新安装插件或设置 DSH_DESKTOP_BIN",
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
        path: "/editor",
        handler: async (_req, res) => html(res, EDITOR_HTML),
      }),
    "desktop-tools: editor page",
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
        path: "/api/host/ensure",
        handler: async (_req, res) => {
          json(res, spawnHostEnsure());
        },
      }),
    "desktop-tools: host ensure api",
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

  // 代码编辑器文件 API（路径严格限制在工作区根目录内）
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/api/fs/tree",
        handler: async (req, res) => {
          const dir = qs(req).get("dir") || ".";
          json(res, fsTree(dir));
        },
      }),
    "desktop-tools: fs tree api",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/api/fs/read",
        handler: async (req, res) => {
          const p = qs(req).get("path") || "";
          json(res, fsRead(p));
        },
      }),
    "desktop-tools: fs read api",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/api/fs/write",
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, { error: "需要 POST" }, 405);
          let body;
          try {
            body = JSON.parse(await readBody(req));
          } catch (e) {
            return json(res, { error: `请求体解析失败：${e.message}` }, 400);
          }
          json(res, fsWrite(String(body.path ?? ""), String(body.content ?? "")));
        },
      }),
    "desktop-tools: fs write api",
  );
}

export { Config, apply, inject, name };

#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PROXY_SCRIPT = path.join(ROOT, "lib", "index.cjs");
const DATA_DIR = path.join(os.homedir(), ".cct");
const PID_FILE = path.join(DATA_DIR, "cct.pid");
const LOG_FILE = path.join(DATA_DIR, "cct.log");
const DEFAULT_PORT = 15722;
const LISTEN_HOST = "127.0.0.1";

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readPid() {
  try {
    const content = fs.readFileSync(PID_FILE, "utf8").trim();
    const pid = Number(content);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    return null;
  }
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: process exists but we lack permission; treat as running.
    return err.code === "EPERM";
  }
}

function readProcessCommandLine(pid) {
  const safePid = Number(pid);
  if (!Number.isInteger(safePid) || safePid <= 0) return "";

  if (process.platform === "win32") {
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${safePid}"; if ($p) { $p.CommandLine }`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  }

  return execFileSync("ps", ["-p", String(safePid), "-o", "args="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function normalizeProcessMatchText(value, platform = process.platform) {
  const normalized = String(value || "").replace(/\\/g, "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

// 首个 token 是否是 node 可执行文件：node / node.exe / nodejs，
// 或 basename 为上述名字的绝对路径（/usr/bin/node、C:\nvm4w\nodejs\node.exe）。
// 用于收紧匹配，排除仅“引用”脚本路径的进程（systemctl status、编辑器、grep 等）。
function isNodeExecutableToken(token, platform = process.platform) {
  const text = normalizeProcessMatchText(token, platform).replace(/^["']|["']$/g, "");
  const base = text.slice(text.lastIndexOf("/") + 1);
  return base === "node" || base === "node.exe" || base === "nodejs";
}

function commandLineMatchesProxyScript(
  commandLine,
  proxyScript = PROXY_SCRIPT,
  platform = process.platform,
  requireNode = false,
) {
  if (typeof commandLine !== "string" || commandLine.trim().length === 0) {
    return false;
  }

  const commandText = normalizeProcessMatchText(commandLine, platform);
  // 匹配目录锚定的相对后缀（lib/index.cjs），而非要求绝对路径出现在命令行里。
  // 这样绝对调用、相对调用（node lib/index.cjs / node ./lib/index.cjs）、
  // 任意 cwd / systemd / npm shim 启动都能命中，且仍限定于本包布局，避免误配其他 index.cjs。
  // normalize 已把反斜杠统一为正斜杠，故后缀恒为 "lib/index.cjs"。
  const suffix = normalizeProcessMatchText("lib/index.cjs", platform);
  if (!commandText.includes(suffix)) return false;

  // 收紧模式：必须是 "node ... lib/index.cjs"，即由 node 解释器真正运行该脚本，
  // 而不是别的进程仅把该路径当作参数引用（如 systemctl status 的 ExecStart 回显）。
  if (requireNode) {
    const firstToken = commandLine.trim().split(/\s+/)[0];
    if (!isNodeExecutableToken(firstToken, platform)) return false;
  }
  return true;
}

function isManagedProxyProcess(pid, deps = {}) {
  const processExists = deps.processExists || isRunning;
  const readCommandLine = deps.readCommandLine || readProcessCommandLine;
  const proxyScript = deps.proxyScript || PROXY_SCRIPT;
  const platform = deps.platform || process.platform;

  try {
    if (!processExists(pid)) return false;
    return commandLineMatchesProxyScript(
      readCommandLine(pid),
      proxyScript,
      platform,
      true,
    );
  } catch (_) {
    return false;
  }
}

// 枚举进程表中所有 { pid, commandLine }。POSIX（Linux/macOS）走 ps，win32 走 CIM。
// 返回 [] 表示枚举失败（调用方按“找不到”处理，而不是抛错）。
function listProcesses(platform = process.platform) {
  try {
    if (platform === "win32") {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 },
      );
      return out
        .split(/\r?\n/)
        .map((line) => {
          const tab = line.indexOf("\t");
          if (tab <= 0) return null;
          const pid = Number(line.slice(0, tab));
          const commandLine = line.slice(tab + 1).trim();
          if (!Number.isInteger(pid) || pid <= 0 || !commandLine) return null;
          return { pid, commandLine };
        })
        .filter(Boolean);
    }

    // -w 宽输出，避免长命令行被按终端宽度截断导致脚本路径匹配失败；procps 与 BSD ps 均支持。
    const out = execFileSync("ps", ["-ewwo", "pid=,args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
    return out
      .split(/\r?\n/)
      .map((line) => {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!m) return null;
        const pid = Number(m[1]);
        const commandLine = m[2];
        if (!Number.isInteger(pid) || pid <= 0 || !commandLine) return null;
        return { pid, commandLine };
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

// 在进程表里找出所有「node 运行本代理脚本」的 pid（排除自身 CLI 进程）。
// 收紧匹配：必须 node 解释器执行 lib/index.cjs，排除仅引用该路径的进程。
function listProxyProcessCandidates(deps = {}) {
  const list = deps.listProcesses || listProcesses;
  const proxyScript = deps.proxyScript || PROXY_SCRIPT;
  const platform = deps.platform || process.platform;
  const selfPid = deps.selfPid != null ? deps.selfPid : process.pid;

  return list(platform)
    .filter(
      (p) =>
        p.pid !== selfPid &&
        commandLineMatchesProxyScript(p.commandLine, proxyScript, platform, true),
    )
    .map((p) => p.pid);
}

// 探测 127.0.0.1:port 是否有监听。返回 Promise<boolean>。
function probePort(port, deps = {}) {
  const host = deps.host || LISTEN_HOST;
  const timeoutMs = deps.timeoutMs != null ? deps.timeoutMs : 800;
  const connect = deps.connect || net.connect.bind(net);

  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    let socket;
    try {
      socket = connect({ host, port });
    } catch (_) {
      finish(false);
      return;
    }
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      finish(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      finish(false);
    });
    socket.once("error", () => {
      socket.destroy();
      finish(false);
    });
  });
}

// 生命周期命令的唯一事实来源：先看端口是否监听，再从进程表/PID 文件找属主 pid。
// deps 全部可注入以便单测。
// 返回 { running, pids, pid, portListening, via }
//   running: 端口在听 或 找到匹配的代理进程
//   pids:    所有匹配代理脚本的 pid（stop/restart 用）
//   pid:     首选属主 pid（PID 文件命中优先，否则取进程表第一个）
//   via:     "pidfile" | "process" | "port" | "none"
async function findProxy(port, deps = {}) {
  const readPidFn = deps.readPid || readPid;
  const probe = deps.probePort || probePort;
  const listCandidates = deps.listProxyProcessCandidates || listProxyProcessCandidates;
  const isManaged = deps.isManagedProxyProcess || isManagedProxyProcess;
  const platform = deps.platform || process.platform;
  const proxyScript = deps.proxyScript || PROXY_SCRIPT;

  const portListening = await probe(port, deps);

  // 进程表匹配（与启动方式无关：systemd 起的进程命令行同样含脚本路径）。
  let pids = listCandidates({ proxyScript, platform, selfPid: deps.selfPid });

  // PID 文件快路径：文件里的 pid 若确实是代理进程且不在进程表结果里，补进来。
  const filePid = readPidFn();
  if (filePid && !pids.includes(filePid) && isManaged(filePid)) {
    pids = [filePid, ...pids];
  }

  let pid = null;
  let via = "none";
  if (filePid && pids.includes(filePid)) {
    pid = filePid;
    via = "pidfile";
  } else if (pids.length > 0) {
    pid = pids[0];
    via = "process";
  } else if (portListening) {
    via = "port";
  }

  const running = portListening || pids.length > 0;
  return { running, pids, pid, portListening, via };
}

function killPid(pid) {
  try {
    process.kill(pid);
    return true;
  } catch (_) {
    return false;
  }
}

function writePid(pid) {
  fs.writeFileSync(PID_FILE, String(pid), "utf8");
}

function clearPid() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function buildArgs(options) {
  const args = [PROXY_SCRIPT];
  if (options.port != null) args.push("--port", String(options.port));
  if (options.saveLastRequest) args.push("--save-last-request");
  if (options.saveLastResponse) args.push("--save-last-response");
  if (options.verbose) args.push("--verbose");
  return args;
}

async function start(options) {
  const args = buildArgs(options);
  const port = options.port || DEFAULT_PORT;

  // 前台模式：stdio 直连当前终端，不 detach、不写 pid，Ctrl+C 直接终止子进程
  if (options.foreground) {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: "inherit",
      windowsHide: false,
    });
    const killChild = (sig) => {
      try { process.kill(child.pid, sig); } catch (e) { /* already exited */ }
    };
    process.on("SIGINT", () => killChild("SIGINT"));
    process.on("SIGTERM", () => killChild("SIGTERM"));
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  // 后台模式（默认）
  ensureDataDir();

  // 已有 cct 代理在跑（无论谁启动的）→ 拒绝重复启动。
  const found = await findProxy(port);
  if (found.pids.length > 0) {
    console.error(`cct already running, pid=${found.pids.join(",")}`);
    process.exit(1);
  }
  // 端口被非 cct 进程占用 → 报端口冲突，而不是误报 already running。
  if (found.portListening) {
    console.error(
      `port ${port} already in use by another program; choose another --port`,
    );
    process.exit(1);
  }
  clearPid();

  const out = fs.openSync(LOG_FILE, "a");
  const err = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
  });
  child.unref();

  writePid(child.pid);
  console.log(`cct started, pid=${child.pid}, port=${port}`);
  console.log(`log: ${LOG_FILE}`);
}

async function stop(options = {}) {
  const port = options.port || DEFAULT_PORT;
  const found = await findProxy(port);

  if (found.pids.length > 0) {
    const failed = found.pids.filter((pid) => !killPid(pid));
    clearPid();
    if (failed.length > 0) {
      console.error(`failed to stop pid=${failed.join(",")}`);
      process.exit(1);
    }
    console.log(`cct stopped, pid=${found.pids.join(",")}`);
    return;
  }

  clearPid();
  if (found.portListening) {
    console.error(
      `cannot stop: no cct proxy process found, but port ${port} is held by another program`,
    );
    process.exit(1);
  }
  console.error("cct not running");
  process.exit(1);
}

async function restart(options) {
  const port = options.port || DEFAULT_PORT;
  const found = await findProxy(port);
  if (found.pids.length > 0) {
    const failed = found.pids.filter((pid) => !killPid(pid));
    if (failed.length > 0) {
      console.error(`failed to stop pid=${failed.join(",")}`);
      process.exit(1);
    }
    console.log(`cct stopped, pid=${found.pids.join(",")}`);
  }
  clearPid();
  // 等待旧进程退出并释放端口，避免立即 start 误判端口占用。
  await waitForExit(found.pids, port);
  await start(options);
}

async function status(options = {}) {
  const port = options.port || DEFAULT_PORT;
  const found = await findProxy(port);

  if (found.pid) {
    console.log(`cct running, pid=${found.pid} (via ${found.via})`);
    return;
  }
  if (found.portListening) {
    console.log(
      `cct listening on ${LISTEN_HOST}:${port} (pid unknown — not started by cct)`,
    );
    return;
  }
  clearPid();
  console.log("cct not running");
  process.exit(1);
}

// 等待给定 pid 退出、且端口不再被监听（有上界，避免死等）。
async function waitForExit(pids, port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = (pids || []).some((pid) => isRunning(pid));
    const listening = alive ? true : await probePort(port);
    if (!alive && !listening) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

function logs() {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf8");
    process.stdout.write(content);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(`no log file at ${LOG_FILE}`);
      process.exit(1);
    }
    throw err;
  }
}

function parseArgs(argv) {
  const options = {
    port: null,
    saveLastRequest: false,
    saveLastResponse: false,
    verbose: false,
    foreground: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") {
      const next = argv[++i];
      if (next == null) {
        console.error("error: --port requires a value");
        process.exit(2);
      }
      const port = Number(next);
      if (!Number.isFinite(port) || port <= 0) {
        console.error(`error: invalid port '${next}'`);
        process.exit(2);
      }
      options.port = port;
    } else if (arg === "--save-last-request") {
      options.saveLastRequest = true;
    } else if (arg === "--save-last-response") {
      options.saveLastResponse = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--foreground") {
      options.foreground = true;
    } else if (arg === "-h" || arg === "--help") {
      positional.push(arg);
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], options };
}

function usage() {
  console.log(`Usage: cct <command> [options]

Commands:
  start      Start the sanitize proxy in the background
  stop       Stop the running proxy
  restart    Restart the running proxy
  status     Show proxy status
  logs       Print the proxy log

Options:
  --port, -p <number>     Override listen port (default 15722)
  --save-last-request     Save last sanitized request to disk
  --save-last-response    Save last upstream/normalized SSE to disk
  --verbose               Print request/response details to console
  --foreground            Run in foreground instead of background (default background)

Files:
  pid:  ${PID_FILE}
  log:  ${LOG_FILE}`);
}

async function main(argv) {
  const { command, options } = parseArgs(argv);

  switch (command) {
    case "start":
      await start(options);
      break;
    case "stop":
      await stop(options);
      break;
    case "restart":
      await restart(options);
      break;
    case "status":
      await status(options);
      break;
    case "logs":
      logs();
      break;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      usage();
      break;
    default:
      console.error(`unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  });
}

module.exports = {
  commandLineMatchesProxyScript,
  findProxy,
  isManagedProxyProcess,
  isNodeExecutableToken,
  listProcesses,
  listProxyProcessCandidates,
  normalizeProcessMatchText,
  probePort,
  readProcessCommandLine,
};

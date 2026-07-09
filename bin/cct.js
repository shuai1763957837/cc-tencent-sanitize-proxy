#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PROXY_SCRIPT = path.join(ROOT, "lib", "index.cjs");
const DATA_DIR = path.join(os.homedir(), ".cct");
const PID_FILE = path.join(DATA_DIR, "cct.pid");
const LOG_FILE = path.join(DATA_DIR, "cct.log");

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

function start(options) {
  const args = buildArgs(options);
  const port = options.port || "15722";

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
  const existing = readPid();
  if (existing && isRunning(existing)) {
    console.error(`cct already running, pid=${existing}`);
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

function stop() {
  const pid = readPid();
  if (!pid) {
    console.error("cct not running (no pid file)");
    process.exit(1);
  }
  if (!isRunning(pid)) {
    clearPid();
    console.error(`cct not running (stale pid=${pid})`);
    process.exit(1);
  }
  try {
    process.kill(pid);
    console.log(`cct stopped, pid=${pid}`);
  } catch (err) {
    console.error(`failed to stop pid=${pid}: ${err.message}`);
    process.exit(1);
  }
  clearPid();
}

function restart(options) {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    try {
      process.kill(pid);
    } catch (err) {
      console.error(`failed to stop pid=${pid}: ${err.message}`);
      process.exit(1);
    }
    clearPid();
    console.log(`cct stopped, pid=${pid}`);
  } else {
    clearPid();
  }
  start(options);
}

function status() {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    console.log(`cct running, pid=${pid}`);
  } else {
    console.log("cct not running");
    process.exit(1);
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

const { command, options } = parseArgs(process.argv.slice(2));

switch (command) {
  case "start":
    start(options);
    break;
  case "stop":
    stop();
    break;
  case "restart":
    restart(options);
    break;
  case "status":
    status();
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

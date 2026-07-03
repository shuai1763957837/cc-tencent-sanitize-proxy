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

function buildEnv(options) {
  const env = { ...process.env };
  if (options.port != null) env.PORT = String(options.port);
  if (options.saveLastRequest) env.SAVE_LAST_REQUEST = "1";
  if (options.saveLastResponse) env.SAVE_LAST_RESPONSE = "1";
  return env;
}

function start(options) {
  ensureDataDir();
  const existing = readPid();
  if (existing && isRunning(existing)) {
    console.error(`cct already running, pid=${existing}`);
    process.exit(1);
  }
  clearPid();

  const env = buildEnv(options);
  const out = fs.openSync(LOG_FILE, "a");
  const err = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
  });
  child.unref();

  writePid(child.pid);
  const port = env.PORT || "15722";
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

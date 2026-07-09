const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const LISTEN_HOST = "127.0.0.1";

// 解析命令行参数：--port <n> --save-last-request --save-last-response --verbose
function parseCliArgs(argv) {
  const opts = {
    port: 15722,
    saveLastRequest: false,
    saveLastResponse: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") {
      const next = argv[++i];
      const port = Number(next);
      if (Number.isFinite(port) && port > 0) opts.port = port;
    } else if (arg === "--save-last-request") {
      opts.saveLastRequest = true;
    } else if (arg === "--save-last-response") {
      opts.saveLastResponse = true;
    } else if (arg === "--verbose") {
      opts.verbose = true;
    }
  }
  return opts;
}

const CLI_OPTS = parseCliArgs(process.argv.slice(2));
const LISTEN_PORT = CLI_OPTS.port;

const CCSWITCH_PREFIX = "/ccswitch-local";
const UPSTREAM_ORIGIN = "https://copilot.tencent.com";
const TARGET_UPSTREAM = "https://copilot.tencent.com/v2/chat/completions";
const SAVE_LAST_SANITIZED_REQUEST = CLI_OPTS.saveLastRequest;
const SAVE_LAST_RESPONSE = CLI_OPTS.saveLastResponse;
const VERBOSE = CLI_OPTS.verbose;
const PROJECT_ROOT = path.join(__dirname, "..");

// 按当天日期切分调试文件，同一天追加，跨天自动切新文件，避免单文件无限膨胀
const DEBUG_DIR = path.join(PROJECT_ROOT, "cc-tencent-debug");

function nowTimestamp() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}`
  );
}

function todayDebugPath() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const dateStr =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return path.join(DEBUG_DIR, `debug-${dateStr}.log`);
}

function appendDebugSection(header, content, persist) {
  const block =
    `\n${"=".repeat(80)}\n[${nowTimestamp()}] ${header}\n${"=".repeat(80)}\n${content}\n`;
  // 落盘由 SAVE_* 开关控制；控制台详细输出由 VERBOSE 控制，默认都不开
  if (persist) {
    try {
      const filePath = todayDebugPath();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, block);
    } catch (error) {
      console.error(`append_debug_error=${error.message}`);
    }
  }
  if (VERBOSE) {
    process.stdout.write(block);
  }
}

const SANITIZE_PATTERNS = [
  // ── Opening sentence (exact match, both CLI and VS Code variants) ──
  {
    name: "branding-opening",
    regex: /You are Claude Code, Anthropic's official CLI for Claude(?:, running within the Claude Agent SDK)?\./gi,
    replacement: "You are an interactive coding agent.",
  },

  // ── Structural block rewrites (line-anchored; run before word-level rules
  //     so deleted block content does not inflate replacement counts) ──
  {
    name: "main-branch-hint",
    regex: /^Main branch(?: \(you will usually use this for PRs\))?:.*(\r?\n)?/gm,
    replacement: (_match, newline = "") => `master branch${newline}`,
  },
  {
    name: "doing-tasks-guidance",
    regex: /^# Doing tasks\r?\n(?:[ \t]+- .*(?:\r?\n|$))+/gm,
    replacement:
      "# Work context\nHandle software engineering tasks in the current workspace with focused, safe, minimal changes.\n",
  },

  // ── Multi-word product names (before single-word rules) ──
  {
    name: "claude-code-product",
    regex: /Claude Code/gi,
    replacement: "the coding agent",
  },
  {
    name: "claude-agent-sdk",
    regex: /Claude Agent SDK/gi,
    replacement: "the Agent SDK",
  },
  {
    name: "claude-api-product",
    regex: /Claude API/gi,
    replacement: "the AI API",
  },
  {
    name: "anthropic-api-product",
    regex: /Anthropic API/gi,
    replacement: "the AI API",
  },
  {
    name: "anthropic-sdk",
    regex: /Anthropic SDK/gi,
    replacement: "the AI SDK",
  },

  // ── Company references (specific → broad: header line, package, possessive, then bare) ──
  {
    name: "anthropic-billing-header",
    regex: /^x-anthropic-billing-header:.*(?:\r?\n)?/gm,
    replacement: "",
  },
  {
    name: "anthropic-package",
    regex: /@anthropic-ai/gi,
    replacement: "@ai-provider-sdk",
  },
  {
    name: "anthropic-possessive",
    regex: /Anthropic's/gi,
    replacement: "the AI provider's",
  },
  {
    name: "anthropic-company",
    regex: /Anthropic/gi,
    replacement: "the AI provider",
  },

  // ── Model IDs (before bare "Claude") ──
  {
    name: "claude-model-ids",
    regex: /\bclaude-(opus-\d+[-\w]*|sonnet-\d+[-\w]*|haiku-\d+[-\w]*|fable-\d+[-\w]*)\b/gi,
    replacement: "model-$1",
  },
  {
    name: "claude-model-family",
    regex: /\bClaude (models|5 family)\b/gi,
    replacement: "the latest models",
  },
  {
    name: "claude-model-named",
    regex: /\bClaude (Opus|Sonnet|Haiku|Fable)(?:\s+\d[\d.]*)?\b/gi,
    replacement: "Model $1",
  },
  {
    name: "claude-model-context",
    regex: /\[1m\]/g,
    replacement: "",
  },

  // ── Domains & hyphenated refs ──
  {
    name: "claude-domain",
    regex: /claude\.ai/gi,
    replacement: "ai-provider.ai",
  },
  {
    name: "claude-hyphenated",
    regex: /\bclaude-(code|api)\b/gi,
    replacement: "ai-$1",
  },

  // ── Catch-all: bare "Claude" after multi-word patterns have fired ──
  {
    name: "claude-bare",
    regex: /\bClaude\b/gi,
    replacement: "the coding agent",
  },

  // ── FleetView ──
  {
    name: "fleetview",
    regex: /FleetView/gi,
    replacement: "Dashboard",
  },
];

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function resolveUpstreamUrl(originalUrl) {
  const requestUrl = new URL(originalUrl || "/", "http://127.0.0.1");
  const isCcswitchPath =
    requestUrl.pathname === CCSWITCH_PREFIX ||
    requestUrl.pathname.startsWith(`${CCSWITCH_PREFIX}/`);

  const upstreamPath = isCcswitchPath
    ? requestUrl.pathname.slice(CCSWITCH_PREFIX.length) || "/"
    : requestUrl.pathname;
  const upstreamUrl = new URL(`${upstreamPath}${requestUrl.search}`, UPSTREAM_ORIGIN);

  return { isCcswitchPath, upstreamUrl };
}

function shouldSanitize({ method, contentType, isCcswitchPath, upstreamUrl }) {
  return (
    method === "POST" &&
    isCcswitchPath &&
    upstreamUrl.href === TARGET_UPSTREAM &&
    typeof contentType === "string" &&
    contentType.toLowerCase().includes("application/json")
  );
}

function sanitizeText(text, stats) {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }

  let result = text;
  for (const rule of SANITIZE_PATTERNS) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    const globalRegex = regex.global
      ? regex
      : new RegExp(regex.source, `${regex.flags}g`);

    const matches = [...result.matchAll(globalRegex)];
    if (matches.length === 0) {
      continue;
    }

    const beforeBytes = Buffer.byteLength(result);
    result = result.replace(globalRegex, rule.replacement);
    const afterBytes = Buffer.byteLength(result);

    stats.replacements += matches.length;
    stats.bytesDelta += afterBytes - beforeBytes;
    stats.rules.add(rule.name);
  }

  return result;
}

function sanitizeContent(content, stats) {
  if (typeof content === "string") {
    return sanitizeText(content, stats);
  }

  if (Array.isArray(content)) {
    return content.map((part) => {
      if (
        part &&
        typeof part === "object" &&
        part.type === "text" &&
        typeof part.text === "string"
      ) {
        return {
          ...part,
          text: sanitizeText(part.text, stats),
        };
      }
      return part;
    });
  }

  return content;
}

function sanitizeRequestJson(value) {
  const stats = {
    replacements: 0,
    bytesDelta: 0,
    rules: new Set(),
  };

  if (value && typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "system")) {
      value.system = sanitizeContent(value.system, stats);
    }

    if (Array.isArray(value.messages)) {
      value.messages = value.messages.map((message) => {
        if (
          !message ||
          typeof message !== "object" ||
          !["system", "developer"].includes(message.role)
        ) {
          return message;
        }

        return {
          ...message,
          content: sanitizeContent(message.content, stats),
        };
      });
    }
  }

  return { value, stats };
}

function writeSanitizedRequest(body) {
  if (!SAVE_LAST_SANITIZED_REQUEST && !VERBOSE) {
    return;
  }
  appendDebugSection("REQUEST (sanitized)", body.toString("utf8"), SAVE_LAST_SANITIZED_REQUEST);
}

function writeDebugFile(label, content) {
  if (!SAVE_LAST_RESPONSE && !VERBOSE) {
    return;
  }
  appendDebugSection(label, content, SAVE_LAST_RESPONSE);
}

function cloneForwardHeaders(headers, bodyLength) {
  const forwarded = {};

  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    forwarded[name] = value;
  }

  if (bodyLength > 0) {
    forwarded["content-length"] = String(bodyLength);
  }

  return forwarded;
}

function cloneResponseHeaders(headers) {
  const forwarded = {};

  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    forwarded[name] = value;
  }

  return forwarded;
}

function normalizeOpenAiSseLine(line) {
  if (typeof line !== "string" || !line.startsWith("data: ")) {
    return line;
  }

  const data = line.slice("data: ".length).trim();
  if (data === "" || data === "[DONE]") {
    return line;
  }

  try {
    const parsed = JSON.parse(data);
    let changed = false;

    if (Array.isArray(parsed.choices)) {
      for (const choice of parsed.choices) {
        if (choice && choice.finish_reason === "") {
          choice.finish_reason = null;
          changed = true;
        }
      }
    }

    if (parsed.usage && typeof parsed.usage === "object") {
      parsed.usage = normalizeUsage(parsed.usage);
      changed = true;
    }

    return changed ? `data: ${JSON.stringify(parsed)}` : line;
  } catch (_) {
    return line;
  }
}

function normalizeOpenAiSseLineWithEnding(line) {
  const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
  const text = ending ? line.slice(0, -ending.length) : line;
  return `${normalizeOpenAiSseLine(text)}${ending}`;
}

function normalizeOpenAiSseStream(streamText) {
  const text = String(streamText || "");
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  return lines.map((line) => normalizeOpenAiSseLineWithEnding(line)).join("");
}

function hasMeaningfulFunctionCallDelta(functionCall) {
  return (
    functionCall &&
    typeof functionCall === "object" &&
    ((typeof functionCall.name === "string" && functionCall.name.length > 0) ||
      (typeof functionCall.arguments === "string" && functionCall.arguments.length > 0))
  );
}

function hasMeaningfulToolCallDelta(toolCall) {
  if (!toolCall || typeof toolCall !== "object") {
    return false;
  }

  const hasIndex =
    Number.isInteger(toolCall.index) || typeof toolCall.index === "number";
  const hasId = typeof toolCall.id === "string" && toolCall.id.length > 0;
  const hasType = typeof toolCall.type === "string" && toolCall.type.length > 0;
  const hasFunction = hasMeaningfulFunctionCallDelta(toolCall.function);

  return hasId || hasType || hasFunction || (hasIndex && hasFunction);
}

function hasToolCallDelta(parsed) {
  for (const choice of parsed.choices || []) {
    const delta = choice?.delta;
    if (
      delta &&
      ((Array.isArray(delta.tool_calls) &&
        delta.tool_calls.some((toolCall) => hasMeaningfulToolCallDelta(toolCall))) ||
        hasMeaningfulFunctionCallDelta(delta.function_call))
    ) {
      return true;
    }
    if (choice?.finish_reason === "tool_calls" || choice?.finish_reason === "function_call") {
      return true;
    }
  }

  return false;
}

function openAiSseStreamHasToolCall(streamText) {
  for (const line of String(streamText || "").split(/\r?\n/)) {
    if (!line.startsWith("data: ")) {
      continue;
    }

    const data = line.slice("data: ".length).trim();
    if (data === "" || data === "[DONE]") {
      continue;
    }

    try {
      if (hasToolCallDelta(JSON.parse(data))) {
        return true;
      }
    } catch (_) {
      continue;
    }
  }

  return false;
}

function createSseTemplate(template) {
  return (
    template || {
      id: "sanitize-proxy-collapsed",
      model: "unknown",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
    }
  );
}

function extractLatestUsage(parsed, currentUsage) {
  if (
    parsed &&
    parsed.usage &&
    typeof parsed.usage === "object" &&
    !Array.isArray(parsed.usage)
  ) {
    return parsed.usage;
  }

  return currentUsage;
}

// Tencent Copilot reports cache stats via prompt_cache_hit_tokens /
// prompt_cache_miss_tokens (and prompt_tokens_details.cached_tokens). Claude Code
// reads cache_read_input_tokens / cache_creation_input_tokens (Anthropic API
// fields) for its cache statistics. Map Tencent's fields into Anthropic's so
// Claude Code reports accurate cache hits instead of always zero.
function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return usage;
  }

  const normalized = { ...usage };

  const hitTokens =
    typeof normalized.prompt_cache_hit_tokens === "number"
      ? normalized.prompt_cache_hit_tokens
      : typeof normalized.prompt_tokens_details?.cached_tokens === "number"
        ? normalized.prompt_tokens_details.cached_tokens
        : null;

  const missTokens =
    typeof normalized.prompt_cache_miss_tokens === "number"
      ? normalized.prompt_cache_miss_tokens
      : null;

  if (
    hitTokens !== null &&
    (!Number.isFinite(normalized.cache_read_input_tokens) ||
      normalized.cache_read_input_tokens === 0)
  ) {
    normalized.cache_read_input_tokens = hitTokens;
  }

  if (
    missTokens !== null &&
    (!Number.isFinite(normalized.cache_creation_input_tokens) ||
      normalized.cache_creation_input_tokens === 0)
  ) {
    normalized.cache_creation_input_tokens = missTokens;
  }

  return normalized;
}

function serializeCollapsedSseChunk(template, choices, usage) {
  const output = {
    ...createSseTemplate(template),
    choices,
  };
  output.usage = normalizeUsage(usage) ?? null;
  return `data: ${JSON.stringify(output)}\n\n`;
}

function appendToolCallDelta(state, deltaToolCall) {
  const index =
    Number.isInteger(deltaToolCall.index) || typeof deltaToolCall.index === "number"
      ? deltaToolCall.index
      : state.toolCalls.size;
  const toolCall = state.toolCalls.get(index) || { index, function: {} };

  if (typeof deltaToolCall.id === "string" && toolCall.id === undefined) {
    toolCall.id = deltaToolCall.id;
  }
  if (typeof deltaToolCall.type === "string" && toolCall.type === undefined) {
    toolCall.type = deltaToolCall.type;
  }
  if (deltaToolCall.function && typeof deltaToolCall.function === "object") {
    if (typeof deltaToolCall.function.name === "string") {
      toolCall.function.name = `${toolCall.function.name || ""}${deltaToolCall.function.name}`;
    }
    if (typeof deltaToolCall.function.arguments === "string") {
      toolCall.function.arguments = `${toolCall.function.arguments || ""}${deltaToolCall.function.arguments}`;
    }
  }

  state.toolCalls.set(index, toolCall);
}

function appendFunctionCallDelta(state, deltaFunctionCall) {
  if (!hasMeaningfulFunctionCallDelta(deltaFunctionCall)) {
    return;
  }

  state.functionCall = state.functionCall || {};
  if (typeof deltaFunctionCall.name === "string") {
    state.functionCall.name = `${state.functionCall.name || ""}${deltaFunctionCall.name}`;
  }
  if (typeof deltaFunctionCall.arguments === "string") {
    state.functionCall.arguments = `${state.functionCall.arguments || ""}${deltaFunctionCall.arguments}`;
  }
}

function collapseOpenAiSseToolCallStream(streamText) {
  let template = null;
  let usage = null;
  const states = new Map();

  for (const line of String(streamText || "").split(/\r?\n/)) {
    if (!line.startsWith("data: ")) {
      continue;
    }

    const data = line.slice("data: ".length).trim();
    if (data === "" || data === "[DONE]") {
      continue;
    }

    try {
      const parsed = JSON.parse(data);
      if (!template) {
        template = parsed;
      }
      usage = extractLatestUsage(parsed, usage);

      for (const choice of parsed.choices || []) {
        const index = Number.isInteger(choice.index) ? choice.index : 0;
        const state =
          states.get(index) ||
          {
            index,
            role: "assistant",
            content: "",
            reasoningContent: "",
            finishReason: null,
            toolCalls: new Map(),
            functionCall: null,
          };
        const delta = choice.delta || {};

        if (typeof delta.role === "string") {
          state.role = delta.role;
        }
        if (typeof delta.content === "string") {
          state.content += delta.content;
        }
        if (
          typeof delta.reasoning_content === "string" &&
          delta.reasoning_content.length > 0
        ) {
          state.reasoningContent += delta.reasoning_content;
        }
        if (typeof choice.message?.content === "string") {
          state.content += choice.message.content;
        }
        if (typeof choice.text === "string") {
          state.content += choice.text;
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const toolCall of delta.tool_calls) {
            if (hasMeaningfulToolCallDelta(toolCall)) {
              appendToolCallDelta(state, toolCall || {});
            }
          }
        }
        if (delta.function_call && typeof delta.function_call === "object") {
          appendFunctionCallDelta(state, delta.function_call);
        }
        if (choice.finish_reason) {
          state.finishReason = choice.finish_reason;
        }

        states.set(index, state);
      }
    } catch (_) {
      continue;
    }
  }

  const orderedStates = [...states.values()].sort((a, b) => a.index - b.index);
  const contentChoices = [];
  const toolChoices = [];

  for (const state of orderedStates) {
    const effectiveContent = state.content.length > 0 ? state.content : state.reasoningContent;
    const hasToolOutput = state.toolCalls.size > 0 || state.functionCall;

    if (effectiveContent.length > 0) {
      contentChoices.push({
        index: state.index,
        delta: {
          role: state.role,
          content: effectiveContent,
        },
        finish_reason: null,
      });
    }

    if (hasToolOutput) {
      const delta = state.toolCalls.size > 0
        ? {
            tool_calls: [...state.toolCalls.values()].sort((a, b) => a.index - b.index),
          }
        : { function_call: state.functionCall };
      if (effectiveContent.length === 0) {
        delta.role = state.role;
      }
      const finishReason = state.finishReason;
      const normalizedFinishReason =
        finishReason === "tool_calls" && state.toolCalls.size === 0 ? "stop" :
        finishReason === "function_call" && !state.functionCall ? "stop" :
        finishReason || (state.toolCalls.size > 0 ? "tool_calls" : "function_call");
      toolChoices.push({
        index: state.index,
        delta,
        finish_reason: normalizedFinishReason,
      });
    }
  }

  if (contentChoices.length === 0 && toolChoices.length === 0 && orderedStates.length > 0) {
    contentChoices.push(
      ...orderedStates.map((state) => ({
        index: state.index,
        delta: {
          role: state.role,
          content: "",
        },
        finish_reason: state.finishReason === "tool_calls" || state.finishReason === "function_call" ? "stop" : state.finishReason || "stop",
      })),
    );
  }

  let output = "";
  if (contentChoices.length > 0) {
    output += serializeCollapsedSseChunk(
      template,
      contentChoices,
      toolChoices.length > 0 ? null : usage,
    );
  }
  if (toolChoices.length > 0) {
    output += serializeCollapsedSseChunk(template, toolChoices, usage);
  }
  return `${output}data: [DONE]\n\n`;
}

function collapseOpenAiSseStream(streamText) {
  const input = String(streamText || "");
  if (openAiSseStreamHasToolCall(input)) {
    return collapseOpenAiSseToolCallStream(input);
  }

  let template = null;
  let content = "";
  let reasoningContent = "";
  let finishReason = "stop";
  let usage = null;

  for (const line of input.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) {
      continue;
    }

    const data = line.slice("data: ".length).trim();
    if (data === "" || data === "[DONE]") {
      continue;
    }

    try {
      const parsed = JSON.parse(data);
      if (!template) {
        template = parsed;
      }
      usage = extractLatestUsage(parsed, usage);

      for (const choice of parsed.choices || []) {
        if (typeof choice.delta?.content === "string") {
          content += choice.delta.content;
        }
        if (
          typeof choice.delta?.reasoning_content === "string" &&
          choice.delta.reasoning_content.length > 0
        ) {
          reasoningContent += choice.delta.reasoning_content;
        }
        if (typeof choice.message?.content === "string") {
          content += choice.message.content;
        }
        if (typeof choice.text === "string") {
          content += choice.text;
        }
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    } catch (_) {
      continue;
    }
  }

  const output = createSseTemplate(template);
  const outputContent = content.length > 0 ? content : reasoningContent;

  output.choices = [
    {
      index: 0,
      delta: {
        role: "assistant",
        content: outputContent,
      },
      finish_reason: finishReason,
    },
  ];
  output.usage = normalizeUsage(usage) ?? null;

  return `data: ${JSON.stringify(output)}\n\ndata: [DONE]\n\n`;
}

function pipeNormalizedOpenAiSse(upstreamRes, res) {
  if (process.env.COLLAPSE_TENCENT_STREAM !== "0") {
    const chunks = [];
    upstreamRes.on("data", (chunk) => chunks.push(chunk));
    upstreamRes.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const normalized = collapseOpenAiSseStream(raw);
      writeDebugFile("RESPONSE (normalized)", normalized);
      res.end(normalized);
    });
    return;
  }

  let pending = "";
  upstreamRes.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    let newlineIndex = pending.indexOf("\n");
    let output = "";

    while (newlineIndex !== -1) {
      const line = pending.slice(0, newlineIndex + 1);
      output += normalizeOpenAiSseLineWithEnding(line);
      pending = pending.slice(newlineIndex + 1);
      newlineIndex = pending.indexOf("\n");
    }

    if (output.length > 0) {
      res.write(output);
    }
  });

  upstreamRes.on("end", () => {
    if (pending.length > 0) {
      res.write(normalizeOpenAiSseLineWithEnding(pending));
    }
    res.end();
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function forwardRequest(req, res, upstreamUrl, body, logInfo) {
  const headers = cloneForwardHeaders(req.headers, body.length);
  if (logInfo.normalizeResponse) {
    headers["accept-encoding"] = "identity";
  }
  const client = upstreamUrl.protocol === "https:" ? https : http;

  const upstreamReq = client.request(
    upstreamUrl,
    {
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      const responseHeaders = cloneResponseHeaders(upstreamRes.headers);
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, responseHeaders);

      const contentType = upstreamRes.headers["content-type"] || "";
      if (
        logInfo.normalizeResponse &&
        typeof contentType === "string" &&
        contentType.toLowerCase().includes("text/event-stream")
      ) {
        pipeNormalizedOpenAiSse(upstreamRes, res);
      } else {
        upstreamRes.pipe(res);
      }

      upstreamRes.on("end", () => {
        console.log(
          `${req.method} ${req.url} target=${logInfo.target} source=${logInfo.source} sanitized=${logInfo.replacements} rules=${logInfo.rules} bytes_delta=${logInfo.bytesDelta} response_normalized=${logInfo.normalizeResponse ? 1 : 0} status=${upstreamRes.statusCode}`,
        );
      });
    },
  );

  upstreamReq.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ error: "sanitize_proxy_upstream_error" }));
    console.error(
      `${req.method} ${req.url} upstream_error=${error.code || error.message}`,
    );
  });

  if (body.length > 0) {
    upstreamReq.write(body);
  }
  upstreamReq.end();
}

async function handleRequest(req, res) {
  const { isCcswitchPath, upstreamUrl } = resolveUpstreamUrl(req.url);
  const contentType = req.headers["content-type"] || "";
  const target = upstreamUrl.href === TARGET_UPSTREAM;
  let body = await readRequestBody(req);
  let replacements = 0;
  let bytesDelta = 0;
  let rules = "-";

  if (
    shouldSanitize({
      method: req.method,
      contentType,
      isCcswitchPath,
      upstreamUrl,
    })
  ) {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      const { value, stats } = sanitizeRequestJson(parsed);
      if (stats.replacements > 0) {
        body = Buffer.from(JSON.stringify(value), "utf8");
      }
      writeSanitizedRequest(body);
      replacements = stats.replacements;
      bytesDelta = stats.bytesDelta;
      rules = stats.rules.size > 0 ? [...stats.rules].join(",") : "-";
    } catch (error) {
      rules = "json-parse-skip";
    }
  }

  forwardRequest(req, res, upstreamUrl, body, {
    target,
    source: isCcswitchPath ? "ccswitch" : "direct",
    replacements,
    bytesDelta,
    rules,
    normalizeResponse: target && isCcswitchPath,
  });
}

function startServer() {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error(`${req.method} ${req.url} proxy_error=${error.stack || error.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ error: "sanitize_proxy_internal_error" }));
    });
  });

  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(`sanitize-proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
    console.log(`cc-switch url http://${LISTEN_HOST}:${LISTEN_PORT}${CCSWITCH_PREFIX}/v2/chat/completions`);
    console.log(`upstream origin ${UPSTREAM_ORIGIN}`);
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  CCSWITCH_PREFIX,
  TARGET_UPSTREAM,
  collapseOpenAiSseStream,
  resolveUpstreamUrl,
  shouldSanitize,
  normalizeOpenAiSseLine,
  normalizeUsage,
  sanitizeRequestJson,
  startServer,
};

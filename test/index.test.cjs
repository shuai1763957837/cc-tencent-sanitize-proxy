const assert = require("node:assert/strict");

const {
  TARGET_UPSTREAM,
  collapseOpenAiSseStream,
  normalizeOpenAiSseLine,
  normalizeUsage,
  resolveUpstreamUrl,
  shouldSanitize,
  sanitizeRequestJson,
} = require("../lib/index.cjs");

function sseData(obj) {
  return `data: ${JSON.stringify(obj)}`;
}

function chunk(id, model, delta, finishReason = "") {
  return {
    id,
    model,
    object: "chat.completion.chunk",
    created: 1,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function firstSseJson(streamText) {
  const line = streamText.split(/\r?\n/).find((item) => item.startsWith("data: "));
  assert.ok(line, "SSE data line not found");
  return JSON.parse(line.slice("data: ".length));
}

function sseJsonLines(streamText) {
  return streamText
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

{
  const resolved = resolveUpstreamUrl("/ccswitch-local/v2/chat/completions");
  assert.equal(resolved.isCcswitchPath, true);
  assert.equal(resolved.upstreamUrl.href, TARGET_UPSTREAM);
}

{
  const routed = resolveUpstreamUrl("/ccswitch-local/v2/chat/completions");
  assert.equal(
    shouldSanitize({
      method: "POST",
      contentType: "application/json",
      isCcswitchPath: routed.isCcswitchPath,
      upstreamUrl: routed.upstreamUrl,
    }),
    true,
  );

  assert.equal(
    shouldSanitize({
      method: "POST",
      contentType: "Application/JSON; charset=utf-8",
      isCcswitchPath: routed.isCcswitchPath,
      upstreamUrl: routed.upstreamUrl,
    }),
    true,
  );

  assert.equal(
    shouldSanitize({
      method: "GET",
      contentType: "application/json",
      isCcswitchPath: routed.isCcswitchPath,
      upstreamUrl: routed.upstreamUrl,
    }),
    false,
  );

  const direct = resolveUpstreamUrl("/v2/chat/completions");
  assert.equal(
    shouldSanitize({
      method: "POST",
      contentType: "application/json",
      isCcswitchPath: direct.isCcswitchPath,
      upstreamUrl: direct.upstreamUrl,
    }),
    false,
  );

  const prefixOnly = resolveUpstreamUrl("/ccswitch-localish/v2/chat/completions");
  assert.equal(prefixOnly.isCcswitchPath, false);
  assert.equal(
    shouldSanitize({
      method: "POST",
      contentType: "application/json",
      isCcswitchPath: prefixOnly.isCcswitchPath,
      upstreamUrl: prefixOnly.upstreamUrl,
    }),
    false,
  );

  const query = resolveUpstreamUrl("/ccswitch-local/v2/chat/completions?debug=1");
  assert.equal(
    shouldSanitize({
      method: "POST",
      contentType: "application/json",
      isCcswitchPath: query.isCcswitchPath,
      upstreamUrl: query.upstreamUrl,
    }),
    false,
  );
}

{
  const body = {
    system: [
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1\nkeep",
      },
    ],
    messages: [
      {
        role: "system",
        content:
          "Main branch (you will usually use this for PRs): product-management-agent",
      },
      {
        role: "developer",
        content: [
          {
            type: "text",
            text: "x-anthropic-billing-header: cc_entrypoint=sdk-cli;\nnotes",
          },
        ],
      },
      {
        role: "user",
        content:
          "x-anthropic-billing-header: must stay\nMain branch (you will usually use this for PRs): must stay",
      },
      {
        role: "assistant",
        content: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
      {
        role: "tool",
        content: "Main branch: must stay",
      },
    ],
  };

  const { value, stats } = sanitizeRequestJson(body);

  assert.equal(value.system[0].text, "keep");
  assert.equal(value.messages[0].content, "master branch");
  assert.equal(value.messages[1].content[0].text, "notes");
  assert.equal(value.messages[2].content, body.messages[2].content);
  assert.equal(value.messages[3].content, body.messages[3].content);
  assert.equal(value.messages[4].content, body.messages[4].content);
  assert.equal(stats.replacements, 3);
  assert.deepEqual([...stats.rules].sort(), [
    "anthropic-billing-header",
    "main-branch-hint",
  ]);
}

{
  const originalSystem =
    "You are Claude Code, Anthropic's official CLI for Claude.\nKeep";
  const expectedSystem = "You are an interactive coding agent.\nKeep";
  const body = {
    messages: [
      {
        role: "system",
        content: originalSystem,
      },
      {
        role: "user",
        content: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
    ],
  };

  const { value, stats } = sanitizeRequestJson(body);

  assert.equal(value.messages[0].content, expectedSystem);
  assert.equal(
    value.messages[1].content,
    "You are Claude Code, Anthropic's official CLI for Claude.",
  );
  assert.equal(stats.replacements, 1);
  assert.equal(
    stats.bytesDelta,
    Buffer.byteLength(expectedSystem) - Buffer.byteLength(originalSystem),
  );
  assert.deepEqual([...stats.rules], ["branding-opening"]);
}

{
  const body = {
    system: "claude and CLAUDE and Claude",
  };

  const { value, stats } = sanitizeRequestJson(body);

  assert.equal(
    value.system,
    "the coding agent and the coding agent and the coding agent",
  );
  assert.equal(stats.replacements, 3);
  assert.deepEqual([...stats.rules], ["claude-bare"]);
}

{
  const body = {
    system:
      "You are Claude Code, Anthropic's official CLI for Claude.\n" +
      "Main branch: product-management-agent\n" +
      "x-anthropic-billing-header: cc_entrypoint=sdk-cli;\n" +
      "Keep",
  };

  const { value, stats } = sanitizeRequestJson(body);

  assert.equal(value.system, "You are an interactive coding agent.\nmaster branch\nKeep");
  assert.equal(stats.replacements, 3);
  assert.deepEqual([...stats.rules].sort(), [
    "anthropic-billing-header",
    "branding-opening",
    "main-branch-hint",
  ]);
}

{
  const body = {
    messages: [
      {
        role: "developer",
        content: [
          {
            type: "text",
            text: "Main branch: remove-me\nKeep",
          },
          {
            type: "image_url",
            image_url: { url: "https://example.invalid/image.png" },
          },
          {
            type: "text",
            text: "No sensitive text",
          },
        ],
      },
    ],
  };

  const { value, stats } = sanitizeRequestJson(body);

  assert.equal(value.messages[0].content[0].text, "master branch\nKeep");
  assert.deepEqual(value.messages[0].content[1], body.messages[0].content[1]);
  assert.equal(value.messages[0].content[2].text, "No sensitive text");
  assert.equal(stats.replacements, 1);
}

{
  const doingTasks =
    '# Doing tasks\n' +
    ' - The user will primarily request you to perform software engineering tasks.\n' +
    ' - Be careful not to introduce security vulnerabilities such as command injection.\n' +
    ' - To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues\n';
  const body = {
    messages: [
      {
        role: "system",
        content: `${doingTasks}\n# Next section\nKeep`,
      },
      {
        role: "user",
        content: doingTasks,
      },
    ],
  };

  const { value, stats } = sanitizeRequestJson(body);

  assert.equal(
    value.messages[0].content,
    "# Work context\nHandle software engineering tasks in the current workspace with focused, safe, minimal changes.\n\n# Next section\nKeep",
  );
  assert.equal(value.messages[1].content, doingTasks);
  assert.equal(stats.replacements, 1);
  assert.deepEqual([...stats.rules], ["doing-tasks-guidance"]);
}

{
  const input =
    'data: {"choices":[{"delta":{"content":"你"},"finish_reason":""}]}';
  const output = normalizeOpenAiSseLine(input);
  assert.equal(
    output,
    'data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}',
  );
}

{
  assert.equal(normalizeOpenAiSseLine("data: [DONE]"), "data: [DONE]");
  assert.equal(normalizeOpenAiSseLine(": ping"), ": ping");
  assert.equal(normalizeOpenAiSseLine("data: not-json"), "data: not-json");
  assert.equal(
    normalizeOpenAiSseLine(
      'data: {"choices":[{"delta":{"content":"你"},"finish_reason":"stop"}]}',
    ),
    'data: {"choices":[{"delta":{"content":"你"},"finish_reason":"stop"}]}',
  );
}

{
  const input = [
    'data: {"id":"abc","model":"deepseek-v4-flash","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":""},"finish_reason":""}]}',
    "",
    'data: {"id":"abc","model":"deepseek-v4-flash","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"content":"你","reasoning_content":""},"finish_reason":""}]}',
    "",
    'data: {"id":"abc","model":"deepseek-v4-flash","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"content":"好","reasoning_content":""},"finish_reason":"stop"}]}',
    "",
    'data: {"id":"abc","model":"deepseek-v4-flash","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"content":"","function_call":{"name":"","arguments":""},"tool_calls":[]},"finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const output = collapseOpenAiSseStream(input);
  assert.equal(
    output,
    [
      'data: {"id":"abc","model":"deepseek-v4-flash","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"你好"},"finish_reason":"stop"}],"usage":null}',
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\n"),
  );
  assert.equal(output.includes("function_call"), false);
  assert.equal(output.includes("tool_calls"), false);
}

{
  const usage = {
    prompt_tokens: 11,
    completion_tokens: 2,
    total_tokens: 13,
    prompt_tokens_details: {
      cached_tokens: 7,
    },
  };
  const input = [
    'data: {"id":"usage-tail","model":"glm-5.2","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}',
    "",
    `data: ${JSON.stringify({
      id: "usage-tail",
      model: "glm-5.2",
      object: "chat.completion.chunk",
      created: 1,
      choices: [],
      usage,
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const output = firstSseJson(collapseOpenAiSseStream(input));

  // cached_tokens maps to cache_read_input_tokens for Claude Code cache stats
  assert.equal(output.usage.cache_read_input_tokens, 7);
  assert.equal(output.usage.prompt_tokens_details.cached_tokens, 7);
}

{
  const input = [
    ': ping\r',
    'data: {"id":"abc","model":"deepseek-v4-flash","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":""}]}\r',
    "\r",
    "data: not-json\r",
    "\r",
    'data: {"id":"abc","model":"deepseek-v4-flash","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"content":"A"},"finish_reason":""},{"index":1,"delta":{"content":"B"},"finish_reason":""}]}\r',
    "\r",
    'data: {"id":"abc","model":"deepseek-v4-flash","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"content":"C"},"finish_reason":"length"}]}\r',
    "\r",
    "data: [DONE]\r",
    "\r",
  ].join("\n");

  const output = firstSseJson(collapseOpenAiSseStream(input));

  assert.equal(output.choices[0].delta.content, "ABC");
  assert.equal(output.choices[0].finish_reason, "length");
  assert.equal(output.usage, null);
}

{
  const output = firstSseJson(collapseOpenAiSseStream(""));

  assert.equal(output.id, "sanitize-proxy-collapsed");
  assert.equal(output.choices[0].delta.role, "assistant");
  assert.equal(output.choices[0].delta.content, "");
  assert.equal(output.choices[0].finish_reason, "stop");
}

{
  const input = [
    'data: {"id":"empty","model":"kimi-k2.7","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":""}]}',
    "",
    'data: {"id":"empty","model":"kimi-k2.7","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const output = collapseOpenAiSseStream(input);
  const emptyOutput = firstSseJson(output);

  assert.match(output, /"model":"kimi-k2.7"/);
  assert.equal(emptyOutput.choices[0].delta.content, "");
  assert.match(output, /"finish_reason":"stop"/);
  assert.equal(output.includes('"content":""'), true);
}

{
  const input = [
    'data: {"id":"reasoning","model":"deepseek-v4-flash","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"分析"},"finish_reason":""}]}',
    "",
    'data: {"id":"reasoning","model":"deepseek-v4-flash","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"reasoning_content":"完成"},"finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const output = firstSseJson(collapseOpenAiSseStream(input));

  assert.equal(output.choices[0].delta.content, "分析完成");
  assert.equal(output.choices[0].finish_reason, "stop");
  assert.equal(JSON.stringify(output).includes("reasoning_content"), false);
}

{
  const input = [
    sseData(chunk("abc", "deepseek-v4-flash", { role: "assistant", content: "准备", reasoning_content: "" })),
    "",
    sseData(chunk("abc", "deepseek-v4-flash", { content: "读取", reasoning_content: "" })),
    "",
    sseData(chunk("abc", "deepseek-v4-flash", { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: "" } }] })),
    "",
    sseData(chunk("abc", "deepseek-v4-flash", { tool_calls: [{ index: 0, function: { arguments: '{"file_path":' } }] })),
    "",
    sseData(chunk("abc", "deepseek-v4-flash", { tool_calls: [{ index: 0, function: { arguments: '"demo.txt"}' } }] })),
    "",
    sseData(chunk("abc", "deepseek-v4-flash", {}, "tool_calls")),
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const output = collapseOpenAiSseStream(input);
  const dataLines = output.split(/\r?\n/).filter((line) => line.startsWith("data: {"));

  assert.match(output, /"tool_calls"/);
  assert.match(output, /"content":"准备读取"/);
  assert.match(output, /"arguments":"\{\\"file_path\\":\\"demo.txt\\"\}"/);
  assert.match(output, /"finish_reason":"tool_calls"/);
  assert.equal(output.includes("reasoning_content"), false);
  assert.equal(dataLines.length, 2);
  assert.equal(output.match(/"content":/g).length, 1);
}

{
  const usage = {
    prompt_tokens: 21,
    completion_tokens: 4,
    total_tokens: 25,
    prompt_tokens_details: {
      cached_tokens: 15,
    },
  };
  const input = [
    sseData(chunk("tool-usage-tail", "glm-5.2", { role: "assistant", content: "准备" })),
    "",
    sseData(chunk("tool-usage-tail", "glm-5.2", { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: '{"file_path":"demo.txt"}' } }] }, "tool_calls")),
    "",
    `data: ${JSON.stringify({
      id: "tool-usage-tail",
      model: "glm-5.2",
      object: "chat.completion.chunk",
      created: 1,
      choices: [],
      usage,
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const output = sseJsonLines(collapseOpenAiSseStream(input));

  assert.equal(output.length, 2);
  assert.equal(output[0].usage, null);
  assert.equal(output[1].usage.cache_read_input_tokens, 15);
  assert.equal(output[1].usage.prompt_tokens_details.cached_tokens, 15);
}

{
  const input = [
    sseData(chunk("empty-tool", "deepseek-v4-flash", { role: "assistant" })),
    "",
    sseData(chunk("empty-tool", "deepseek-v4-flash", {}, "tool_calls")),
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const output = firstSseJson(collapseOpenAiSseStream(input));

  assert.equal(output.choices[0].delta.content, "");
  assert.equal(output.choices[0].finish_reason, "stop");
  assert.equal(JSON.stringify(output).includes("tool_calls"), false);
}

{
  const input = [
    sseData(chunk("tool-reasoning", "deepseek-v4-flash", { role: "assistant", reasoning_content: "I should call a tool." })),
    "",
    sseData(chunk("tool-reasoning", "deepseek-v4-flash", { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: '{"file_path":"demo.txt"}' } }] }, "tool_calls")),
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const output = collapseOpenAiSseStream(input);
  const dataLines = output.split(/\r?\n/).filter((line) => line.startsWith("data: {"));

  assert.equal(dataLines.length, 2);
  assert.match(output, /"content":"I should call a tool."/);
  assert.match(output, /"tool_calls"/);
  assert.match(output, /"finish_reason":"tool_calls"/);
  assert.equal(output.includes("reasoning_content"), false);
}

{
  const input = [
    sseData(chunk("kimi-tool", "kimi-k2.7", { role: "assistant", content: "", reasoning_content: "" })),
    "",
    sseData(chunk("kimi-tool", "kimi-k2.7", { content: "", reasoning_content: "The user wants to close the local port." })),
    "",
    sseData(chunk("kimi-tool", "kimi-k2.7", { content: "", reasoning_content: " I will use PowerShell." })),
    "",
    sseData(chunk("kimi-tool", "kimi-k2.7", { content: "", reasoning_content: "", tool_calls: [{ index: 0, id: "PowerShell_0", type: "function", function: { name: "PowerShell", arguments: "" } }] })),
    "",
    sseData(chunk("kimi-tool", "kimi-k2.7", { content: "", reasoning_content: "", tool_calls: [{ index: 0, function: { arguments: '{"command": "' } }] })),
    "",
    sseData(chunk("kimi-tool", "kimi-k2.7", { content: "", reasoning_content: "", tool_calls: [{ index: 0, function: { arguments: 'stop"}' } }] }, "tool_calls")),
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const output = collapseOpenAiSseStream(input);
  const dataLines = output.split(/\r?\n/).filter((line) => line.startsWith("data: {"));

  assert.equal(dataLines.length, 2);
  assert.match(output, /"content":"The user wants to close the local port\. I will use PowerShell\."/);
  assert.match(output, /"name":"PowerShell"/);
  assert.match(output, /"arguments":"\{\\"command\\": \\"stop\\"\}"/);
  assert.equal(output.includes("reasoning_content"), false);
  assert.equal(output.includes('"content":""'), false);
}

{
  const input = [
    sseData(chunk("reasoning-only", "kimi-k2.7", { role: "assistant", content: "", reasoning_content: "" })),
    "",
    sseData(chunk("reasoning-only", "kimi-k2.7", { content: "", reasoning_content: "only reasoning" }, "stop")),
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const output = firstSseJson(collapseOpenAiSseStream(input));

  assert.equal(output.choices[0].delta.content, "only reasoning");
  assert.equal(output.choices[0].finish_reason, "stop");
  assert.equal(JSON.stringify(output).includes("reasoning_content"), false);
}

{
  // Tencent returns prompt_cache_hit_tokens / prompt_cache_miss_tokens; the
  // proxy must map them to cache_read_input_tokens / cache_creation_input_tokens
  // so Claude Code reports accurate cache stats. Mirrors real glm-5.2 usage.
  const tencentUsage = {
    prompt_tokens: 36852,
    completion_tokens: 2,
    total_tokens: 36854,
    prompt_tokens_details: { cached_tokens: 7936 },
    prompt_cache_hit_tokens: 7936,
    prompt_cache_miss_tokens: 28916,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const tail = {
    id: "cmb-584450",
    model: "glm-5.2",
    object: "chat.completion.chunk",
    created: 1783071663,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "pong" },
        finish_reason: "stop",
      },
    ],
    usage: tencentUsage,
  };
  const input = [
    sseData(chunk("cmb-584450", "glm-5.2", { role: "assistant", content: "pong" }, "stop")),
    "",
    `data: ${JSON.stringify(tail)}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const output = firstSseJson(collapseOpenAiSseStream(input));

  assert.equal(output.usage.prompt_cache_hit_tokens, 7936);
  assert.equal(output.usage.cache_read_input_tokens, 7936);
  assert.equal(output.usage.prompt_cache_miss_tokens, 28916);
  assert.equal(output.usage.cache_creation_input_tokens, 28916);
}

{
  // Direct normalizeUsage unit checks: hit/miss map to read/creation;
  // already-populated Anthropic fields are preserved (not overwritten).
  assert.equal(
    normalizeUsage({
      prompt_cache_hit_tokens: 100,
      prompt_cache_miss_tokens: 50,
    }).cache_read_input_tokens,
    100,
  );
  assert.equal(
    normalizeUsage({
      prompt_cache_hit_tokens: 100,
      prompt_cache_miss_tokens: 50,
    }).cache_creation_input_tokens,
    50,
  );
  assert.equal(
    normalizeUsage({
      prompt_tokens_details: { cached_tokens: 8 },
    }).cache_read_input_tokens,
    8,
  );
  assert.equal(
    normalizeUsage({
      prompt_cache_hit_tokens: 100,
      cache_read_input_tokens: 42,
    }).cache_read_input_tokens,
    42,
  );
  assert.deepEqual(normalizeUsage(null), null);
  assert.deepEqual(normalizeUsage(undefined), undefined);
}

console.log("cc-tencent-sanitize-proxy tests passed");

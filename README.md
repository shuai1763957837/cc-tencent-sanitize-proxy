# cc-tencent-sanitize-proxy

Claude Code 通过 cc-switch 接入腾讯 Copilot Chat Completions 的本地代理。

它用于解决两类兼容问题：

- Claude Code 的 system/developer prompt 触发腾讯侧敏感内容拦截。
- 腾讯 SSE 流式响应格式导致 Claude Code 输出缺字、空输出、工具调用异常或 fallback 到非流式请求。

代理链路：

```text
Claude Code
  -> cc-switch
  -> http://127.0.0.1:15722/ccswitch-local/v2/chat/completions
  -> https://copilot.tencent.com/v2/chat/completions
```

只处理这条 cc-switch 到腾讯 Copilot 的 chat completions 链路，不改 cc-switch 源码，不拦截其他 URL。

## 使用

要求 Node.js 18+。

### CLI 命令（推荐）

从 GitHub 一键安装并启动：

```bash
npm install -g shuai1763957837/cc-tencent-sanitize-proxy && cct start
```

或克隆后再安装：

```bash
git clone https://github.com/shuai1763957837/cc-tencent-sanitize-proxy.git
cd cc-tencent-sanitize-proxy
npm install -g . && cct start
```

常用命令：

```bash
cct start     # 后台启动代理
cct stop      # 停止代理
cct restart   # 重启代理
cct status    # 查看运行状态
cct logs      # 打印日志
```

可选参数：

```bash
cct start --port 15722 --save-last-request --save-last-response --verbose --foreground
```

- `--foreground`：前台运行（默认后台）。前台时日志直接输出到当前终端，`--verbose` 的详细出入参实时可见，Ctrl+C 终止；不写 pid 文件。
- 其余调试开关（`--save-last-request` / `--save-last-response` / `--verbose`）详见下文[调试](#调试)章节。

后台模式下，PID 文件与日志文件位于用户目录：`~/.cct/cct.pid`、`~/.cct/cct.log`。

### 直接运行

不安装也可直接以脚本方式前台运行：

```bash
node lib/index.cjs
```

默认监听：

```text
http://127.0.0.1:15722
```

## cc-switch 配置

先从 CodeBuddy 个人设置获取 API key：

```text
https://www.codebuddy.cn/profile/keys
```

ccswitch 请求地址完整 URL 填写：

```text
http://127.0.0.1:15722/ccswitch-local/v2/chat/completions
```

token 使用上面获取的 API key。model、api format 等其他配置保持不变。

## 修改规则

敏感文本替换规则在 `lib/index.cjs` 顶部：

```js
const SANITIZE_PATTERNS = [
  // edit regex rules here
];
```

改完规则后重启代理。

## 调试

默认只打印每次请求的汇总行（HTTP 方法、命中规则、字节差、状态码等），不落盘、不打印详细出入参。需要时通过 CLI 开关按需开启：

- `--save-last-request`：把每次请求清洗后的 prompt **落盘**。
- `--save-last-response`：把每次请求腾讯原始 SSE 与代理归一化后的 SSE **落盘**。
- `--verbose`：把每次请求的详细出入参**输出到控制台**。

三个开关相互独立，可任意组合：

```bash
# 前台运行 + 实时看详细出入参（最常用的调试方式）
cct start --foreground --verbose

# 只在控制台看详细出入参，不落盘
cct start --verbose

# 只落盘，不刷控制台
cct start --save-last-request --save-last-response

# 同时落盘 + 控制台输出
cct start --save-last-request --save-last-response --verbose
```

落盘文件按当天日期切分，同一天追加、跨天自动切新文件，避免单文件无限膨胀：

```text
cc-tencent-debug/debug-YYYY-MM-DD.log
```

文件按请求时间戳分段，格式如下：

```text
================================================================================
[2026-07-09 12:27:03.918] REQUEST (sanitized)
================================================================================
{"system":"...","messages":[...]}

================================================================================
[2026-07-09 12:27:04.285] RESPONSE (normalized)
================================================================================
data: ...

data: [DONE]
```

`RESPONSE` 段落需上游请求成功才会生成（401 等失败不会记录响应）。

## License

MIT

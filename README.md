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

```bash
node cc-tencent-sanitize-proxy.cjs
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

把腾讯 provider URL 从：

```text
https://copilot.tencent.com/v2/chat/completions
```

改成：

```text
http://127.0.0.1:15722/ccswitch-local/v2/chat/completions
```

token 使用上面获取的 API key。model、api format 等其他配置保持不变。

## 验证

先跑脚本测试：

```bash
node cc-tencent-sanitize-proxy.test.cjs
```

再跑 Claude Code 端到端测试：

```bash
claude -p "只输出一句中文：端到端流式测试" --output-format=stream-json --verbose --debug api
```

## 修改规则

敏感文本替换规则在 `cc-tencent-sanitize-proxy.cjs` 顶部：

```js
const SANITIZE_PATTERNS = [
  // edit regex rules here
];
```

改完规则后重启代理。

## 调试

保存最近一次清洗后的请求：

```bash
SAVE_LAST_REQUEST=1 node cc-tencent-sanitize-proxy.cjs
```

保存腾讯原始 SSE 和代理归一化后的 SSE：

```bash
SAVE_LAST_RESPONSE=1 node cc-tencent-sanitize-proxy.cjs
```

调试文件会写到当前目录，已在 `.gitignore` 中忽略。

## License

MIT

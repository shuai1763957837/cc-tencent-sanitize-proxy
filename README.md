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
cct start --port 15722 --save-last-request --save-last-response
```

PID 文件与日志文件位于用户目录：`~/.cct/cct.pid`、`~/.cct/cct.log`。

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

保存最近一次清洗后的请求：

```bash
cct start --save-last-request
# 或
SAVE_LAST_REQUEST=1 node lib/index.cjs
```

保存腾讯原始 SSE 和代理归一化后的 SSE：

```bash
cct start --save-last-response
# 或
SAVE_LAST_RESPONSE=1 node lib/index.cjs
```

调试文件会写到当前目录，已在 `.gitignore` 中忽略。

## License

MIT

# 更新日志

本项目的所有重要变更都记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.1] - 2026-10-27

### 修复
- 裸 `Claude` 兜底规则（`/\bClaude\b/gi`）会把路径片段和文件名一并当作品牌文案替换。`.`、`-`、`\`、`/` 均为非单词字符，`\b` 在 `D:\Users\<name>\.claude\plans\` 中依然成立，于是规则把提示词自身的路径改写成 `\.the coding agent\plans\`；模型据此把计划文件与记忆文件写入一个从未存在过的目录，而改写后的路径本身仍然合法，错误因此自洽并延续数月。同一条规则还把 `CLAUDE.md` 改写为 `the coding agent.md`，导致模型去读一个并不存在的项目指令文件。规则现改为 `/(?<![.\-\\/])\bClaude\b(?!\.\w)/gi`：前置 `.`、`-`、`\`、`/` 或后接 `.扩展名` 的匹配视为路径或文件名片段，保持原样。品牌文案（`Claude`、`CLAUDE`、`Claude Code`）仍会替换，`claude.ai` 仍由独立的 `claude-domain` 规则处理。注意仅 `system` / `developer` 内容参与脱敏，`user` / `assistant` / `tool` 轮次从未受影响——这也是同一会话中会同时存在改写前后两种路径的原因。
- `cct status` / `cct stop` / `cct restart` 此前只信任 `~/.cct/cct.pid` 文件，而该文件只有 `cct start` 会写入——因此由 systemd（或任何外部启动方式）拉起的代理会显示为 `not running`，即使端口正在监听并转发也无法停止。现在这三条命令改为：探测 `127.0.0.1:<port>` 端口 + 在进程表中匹配 `lib/index.cjs` 命令行来发现代理，PID 文件降级为快路径提示。命令行匹配也从绝对脚本路径放宽为目录锚定后缀 `lib/index.cjs`，使相对路径 / `./` / npm shim / systemd 等各类启动方式都能命中。`cct start` 现在仅在检测到真实的 cct 代理时才拒绝启动；当端口被非 cct 程序占用时，改为报“端口冲突”而非“已在运行”。

## 历史数据修复指引

本次修复只改变代理的转发行为，**不会自动修正已经被写错位置的历史数据**。受影响的文件真实存在、内容完整，只是所在目录名被改成了 `the coding agent`，因此可以无损迁移回来。

### 受影响的用户

只要满足以下任一条件，就需要执行下面的修复：

- `%USERPROFILE%\.the coding agent\` 目录存在（Windows），或 `~/.the coding agent/` 存在（macOS / Linux）
- `%USERPROFILE%\.the-claude-agent\` 目录存在（同一缺陷产生的另一种拼写变体）

### 复制下面这段 prompt 给你的 Claude Code

```text
我的机器上存在一个由旧版 cc-tencent-sanitize-proxy 导致的目录污染，需要你做一次无损迁移。请严格按下面的原因说明和步骤执行，不要自作主张改变步骤顺序。

## 背景（原因）

旧版代理有一条兜底脱敏规则 /\bClaude\b/gi，本意是把 system prompt 里的品牌词 Claude
替换成中性词。但 \b 只判断单词边界，而 . 是非单词字符，所以路径片段 .claude 也被当成了
品牌词，被替换成 "the coding agent"。于是 Claude Code 收到的系统提示词里，原本指向
<用户目录>\.claude\plans\ 和 <用户目录>\.claude\projects\<项目>\memory\ 的路径，变成了
<用户目录>\.the coding agent\plans\ 和 <用户目录>\.the coding agent\projects\<项目>\memory\。
模型照着被改写的路径写文件，这些文件就落在了错误的位置。

关键点：只有 system / developer 角色的内容被脱敏，user / assistant / tool 内容原样透传。
所以同一台机器上，一部分会话把文件写进了 .claude，另一部分写进了 .the coding agent，
两边可能都有文件，也可能同名但内容不同。

新版代理已把该规则修正为 /(?<![.\-\\/])\bClaude\b(?!\.\w)/gi，路径和 CLAUDE.md 不会再被改写。
但历史文件不会自动搬家，需要手动迁移一次。

## 目标

把 .the coding agent 和 .the-claude-agent 里的文件，无损合并到正确的 .claude 目录，
不丢失任何内容，不覆盖更新的版本，然后清理错误目录。

## 执行步骤

第 0 步：先确认新版代理已生效，否则迁移完还会继续写错位置。
  - 检查当前运行的代理代码里，claude-bare 规则是否为
    /(?<![.\-\\/])\bClaude\b(?!\.\w)/gi
  - 若仍是旧的 /\bClaude\b/gi，先更新代码并重启代理，再继续。
  - 若你的代理部署在远端服务器上，必须先在远端更新并重启，否则本机迁移无意义。

第 1 步：侦察，只读，不做任何修改。
  - 列出两个污染目录的完整结构和文件数：
      <用户目录>\.the coding agent\plans\*.md
      <用户目录>\.the coding agent\projects\*\memory\*.md
      <用户目录>\.the-claude-agent\
  - 列出目标目录现状：
      <用户目录>\.claude\plans\*.md
      <用户目录>\.claude\projects\*\memory\*.md
  - 把结果整理成表格报给我看，包含：每个文件的路径、大小、修改时间，
    以及目标位置是否已存在同名文件。做完这一步就停下来等我确认。

第 2 步：处理同名冲突，必须在移动之前。
  - 对每个同名文件，比较两边内容（md5 或 diff）。
  - 内容相同：可以丢弃污染侧，但要先告知我。
  - 内容不同：两份都要保留。把污染侧的重命名为 <原名>.pre-migration.md 放在目标目录，
    不要覆盖任何一边。逐个人工判断该保留哪份，报给我决定。
  - 对每个项目的 memory\MEMORY.md：这是索引文件，两边都可能有对方没有的条目。
    必须逐条比对做并集，而不是用其中一份覆盖另一份。漏掉条目等于那条记忆永远不会被召回。

第 3 步：移动文件，保留 mtime。
  - 优先用能保留时间戳的方式移动（Windows 用 Move-Item，Unix 用 mv，不要用 cp 后再删）。
  - 目标路径映射：
      .the coding agent\plans\X.md               -> .claude\plans\X.md
      .the coding agent\projects\<P>\memory\X.md -> .claude\projects\<P>\memory\X.md
  - 目标子目录不存在就先创建。
  - 不要移动 .git、.gitignore、临时脚本（.tmp_*）等非数据文件，除非我明确要求。

第 4 步：核对，确认无损。
  - 统计迁移前后 .claude\plans 和 .claude\projects\*\memory 的文件数，
    数字应等于 原有数 + 迁入数。
  - 抽查至少 3 个大文件，确认字节数与原文件一致。
  - 确认每个 MEMORY.md 里，污染侧原有的每一条索引都能在新文件里找到。

第 5 步：清理，仅在核对全部通过且我明确同意后执行。
  - 删除 .the coding agent 和 .the-claude-agent 两个目录。
  - 删除前再扫一遍，确认没有遗漏的、目标位置不存在的唯一副本。

## 注意事项

1. 不要跳过第 1 步直接动手。这两个目录里的文件是真实数据，不是缓存，误删无法恢复。
2. 不要用覆盖式合并。同名不同内容的情况一定存在，覆盖会丢数据。
3. MEMORY.md 是索引不是内容，必须做并集，不能二选一。
4. 移动时必须保留 mtime。Claude Code 有按修改时间清理旧文件的机制
   （配置项 cleanupPeriodDays，默认 30 天），如果移动时把 mtime 刷成当前时间，
   这些旧计划文件的“年龄”就丢了；反过来如果本来就不该保留，也应该由你决定，
   而不是被时间戳意外影响。迁移完成后建议把 cleanupPeriodDays 设为 0 或足够大的值，
   避免刚恢复的历史文件又被清理掉。
5. 如果文件已经在污染目录里躺了超过 30 天，建议先备份再迁移。Claude Code 启动时
   会按 cleanupPeriodDays 清理 plans 目录，长期未被访问的历史文件可能在迁移前就
   已经被删掉一部分。第 1 步侦察时会看到实际还剩多少，以那个结果为准，
   不要假设“原本应该有但没看到”的文件还能找回。
6. 整个过程中，凡是需要删除或覆盖的操作，都要先向我确认。
7. 如果你发现 <用户目录>\.claude 下某些文件的路径也被改写成了 the coding agent，
   说明污染更深（例如文件内容里写了错误路径），单独报给我，不要自行批量改写内容。
```

### 迁移时容易踩的三个坑

1. **`MEMORY.md` 是索引，不是内容**。它列的是「这条记忆在哪个文件」的指针。两边各有对方没有的条目时，用任一份覆盖另一份，都会让一部分记忆永久失去召回入口。必须做并集。

2. **同名不同内容一定存在**。因为只有 `system` / `developer` 被脱敏，同一台机器上有的会话写对了位置、有的写错了，两边会产生同名但内容不同的文件（例如同一个计划被不同会话各写一次）。覆盖式迁移必丢数据。

3. **`cleanupPeriodDays` 默认 30 天，按 mtime 删**。Claude Code 启动时会清理 `plans` 目录下修改时间超过 `cleanupPeriodDays` 的文件。迁移用的是 `mv` 这类保留时间戳的操作，所以搬进来的历史文件仍带着旧的 mtime，**随时可能在下次启动时被当成过期文件删掉**。迁移完成后应立刻把 `cleanupPeriodDays` 设为 `0`（关闭清理）或一个足够大的值，并备份一份。

## [0.3.0] - 2026-07-02

### 新增
- 新增 `cct` CLI 命令（`cct start` / `cct stop` / `cct restart` / `cct status` / `cct logs`）用于后台进程管理，支持 `--port`、`--save-last-request`、`--save-last-response` 参数。
- `package.json` 补充声明 `bin`、`main`、`files`、`engines` 与 npm scripts。
- README 补充 GitHub 一行安装方式（`npm install -g shuai1763957837/cc-tencent-sanitize-proxy`）。

### 变更
- 重组为标准 npm 包结构：源码移至 `lib/index.cjs`，测试移至 `test/index.test.cjs`，CLI 入口为 `bin/cct.js`。调试产物改为通过 `path.join(__dirname, "..")` 定位到项目根目录。

### 修复
- 将腾讯 Copilot 的缓存字段（`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 以及 `prompt_tokens_details.cached_tokens`）在归一化后的 SSE 中映射为 Anthropic 的 `cache_read_input_tokens` / `cache_creation_input_tokens`。Claude Code 依据 Anthropic 字段统计缓存，此前即使腾讯侧命中缓存也始终显示为零命中。已端到端验证：Claude Code 现在能报告非零的 `cacheReadInputTokens`。

### 新增
- 扩充脱敏规则，覆盖多词产品名（`Claude Code`、`Claude Agent SDK`、`Claude API`、`Anthropic API`、`Anthropic SDK`）、公司名称引用（所有格、`@anthropic-ai` 包名、裸 `Anthropic`）、模型 ID 与系列（`claude-opus-*`、`claude-sonnet-*` 等）、域名（`claude.ai`）、连字符引用以及 `FleetView`。
- 调整规则顺序，使多词模式先于裸 `Claude` 兜底规则执行，避免对被删除区块内容重复计数导致替换数虚高。

### 变更
- 将 CLI 与 VS Code 两种品牌开场句规则合并为单条规则。
- 重写 `sanitizeText` 为“先 `matchAll` 再替换”的方式，以精确统计替换次数与 `bytesDelta`，同时兼容全局与非全局的正则源。

### 修复
- 修复空 tool_call 流导致的 `[Tool use interrupted]`。`kimi-k2.7` 偶尔返回 `finish_reason=tool_calls` 却不带任何有效的 tool_call 增量（只有 `index` 占位帧）。旧逻辑会输出空的 `tool_calls` 外壳并硬编码 `finish_reason`，导致 Claude Code 拿不到工具名与参数并报告中断。
  - `hasMeaningfulToolCallDelta` 现在会过滤掉纯 `index` 占位帧。
  - 当声明了 `tool_calls`/`function_call` 却没有对应输出时，`normalizedFinishReason` 降级为 `stop`。
  - 空的兜底 `content` 由零宽空格改为空字符串。
  - `fallbackContent` 更名为 `reasoningContent`；`message.content`/`text` 合并进主 `content`。

### 移除
- 移除验证说明。
- 简化使用说明与 ccswitch URL 说明。

## [0.2.0] - 2026-07-01

### 变更
- 简化使用说明。

## [0.1.0] - 2026-07-01

### 新增
- cc tencent sanitize proxy 首次发布。

[未发布]: https://github.com/shuai1763957837/cc-tencent-sanitize-proxy/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/shuai1763957837/cc-tencent-sanitize-proxy/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/shuai1763957837/cc-tencent-sanitize-proxy/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/shuai1763957837/cc-tencent-sanitize-proxy/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/shuai1763957837/cc-tencent-sanitize-proxy/releases/tag/v0.1.0


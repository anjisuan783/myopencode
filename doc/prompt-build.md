# 用户消息提交 → LLM prompt 构建全流程参考

> 本文是 2026-09 一次完整调查的沉淀：当用户提交一条新消息时，opencode 服务端
> 如何从零构建发往 LLM 的 prompt（system + messages + tools + params）。
> 涉及删除消息后为何"下一次 prompt 自动生效"、以及右侧 sidebar Context 数字
> 的来源。下次改这段代码先读这里，不用再从头翻。

## 0. 一句话总结

用户回车 → TUI 只把 `{text, files, agent, model}` 通过 `session.prompt` 发给服务端。
服务端 `SessionPrompt.prompt` 把 user 消息落库后进入 `runLoop`：**每一轮迭代都从
SQLite 重新读全量历史**（compaction 过滤 + 重排），解析 agent/model，注入 reminders，
解析工具，组装系统提示（personality + env + AGENTS.md + MCP + skills），把历史消息
逐条转换成模型消息（`toModelMessagesEffect`，含大量过滤/改写规则），最后
`LLMRequestPrep.prepare` 拼成最终请求，`llm.stream` 发送。整个 prompt 完全由
**服务端数据**构建，TUI 只是渲染投影。

---

## 1. 关键文件 / 函数 / 行号速查

| 文件 | 关键位置 | 作用 |
|---|---|---|
| `src/session/prompt.ts` | `prompt` :1052 | 入口：revert.cleanup → createUserMessage → loop |
| 同上 | `createUserMessage` :635 | 解析用户输入 parts 并落库，发 `message.updated`(user) |
| 同上 | `runLoop` :1081 / loop 每轮 :1088 | 回合主循环，一轮 = 一次模型调用 |
| 同上 | 历史读取 :1092 | `MessageV2.filterCompactedEffect` |
| 同上 | 溢出自动压缩 :1161-1168 | `isOverflow` → 先 compaction 再回答 |
| 同上 | assistant 空壳 :1186-1201 | 零 tokens 的 assistant 消息，先落库 |
| 同上 | tools/system/process 组装 :1242-1302 | 一轮里的核心组装 |
| `src/session/message-v2.ts` | `filterCompacted` :520-571 | 隐藏被压缩的历史 + 重排 |
| 同上 | `filterCompactedEffect` :573 | 从 DB 全量读取后调用 filterCompacted |
| 同上 | `stream` :468 | 分页读全量消息+parts |
| 同上 | `toModelMessagesEffect` :131-414 | 历史 → 模型消息（过滤/改写/媒体提取） |
| 同上 | `toModelMessages` :416 | 同步包装（供 compaction 等复用） |
| `src/session/reminders.ts` | `apply` :15 | plan/build 模式提示注入 |
| `src/session/tools.ts` | `resolve` :41 | 解析工具集（agent + MCP + 权限过滤） |
| `src/session/system.ts` | `environment` :67 / `skills` :105 / `mcp` :119 | 系统提示各部分 |
| 同上 | `provider` :27-49 | 按模型家族选 base prompt（anthropic/gpt/gemini/...） |
| `src/session/instruction.ts` | `system` :155 | 读取 AGENTS.md / 指令文件 |
| `src/session/llm/request.ts` | `prepare` :56-226 | 最终请求组装（system/messages/tools/params） |
| `src/session/llm.ts` | `run` :85 / `streamText` :280 | 运行时选择（native/AI SDK）与发送 |
| `src/session/processor.ts` | `process` :627 / `step-finish` :435-456 | 消费流式事件；tokens 在此附着 |

---

## 2. 完整数据流

### 2.1 入口：prompt 提交

1. TUI 输入框回车 → `sdk.client.session.prompt({ sessionID, text, ... })`。
   TUI 只发 user 的输入与选择（text / files / agent / model），**不带历史**。
2. 服务端 `SessionPrompt.prompt`(prompt.ts:1052)：
   - `revert.cleanup`（清掉暂存的 revert 状态）。
   - `createUserMessage`(:635)：解析输入 parts（text/file/command...）→ `save` 落库 →
     `updateMessage(info)` → 发 **`message.updated`(role=user)**。
   - `sessions.touch` 更新 session 时间戳；工具开关合并进 `session.permission`。
   - `loop({sessionID})` 开始，`status.set(busy)`。

### 2.2 runLoop：每轮迭代（prompt.ts:1088+）

`while(true)`，每一轮对应一次模型调用（工具调用会触发下一轮）：

1. **读全量历史**（:1092）：`MessageV2.filterCompactedEffect(sessionID)` ——
   `stream()`(:468) 分页读 SQLite 全部消息+parts，再 `filterCompacted`(:520)：
   - 隐藏被上次压缩吞掉的消息，重排为
     `[compaction-user("What did we do so far?"), summary-assistant, ...保留的尾部, ...最新]`，
     即摘要顶替旧历史。
2. **解析最新状态**：`MessageV2.latest`(:581) → last user / last assistant /
   last finished / pending tasks（compaction/subtask part）。
3. **退出/任务闸门**：
   - last assistant 已 finish 且非 tool-calls → `break`（回合结束）。
   - 有 pending subtask → 先执行子任务；有 pending compaction → 先压缩。
   - `isOverflow(lastFinished.tokens, model)`(:1161-1168) → 先自动压缩，本轮不回答。
4. **解析 agent 与 model**（:1141,1170）：从 **user 消息** 上取（提交时定的），
   不是 session 级状态。
5. **Reminders**（`SessionReminders.apply`，reminders.ts:15）：向最后一条 user 消息追加
   synthetic 文本 part（plan 模式 PROMPT_PLAN / 切 build 的 BUILD_SWITCH 等）。
6. **创建 assistant 空壳**（:1186-1201）：零 tokens、无 finish/error，先 `updateMessage`
   落库 —— 这是"半截"消息的诞生点。
7. **解析工具**（`SessionTools.resolve`，tools.ts:41）：agent 工具白名单 + MCP 工具 +
   权限过滤 → `{name, description, inputSchema}` 集合。
8. **系统提示组装**（:1273-1285）：见 §3。
9. **历史 → 模型消息**（`MessageV2.toModelMessagesEffect(msgs, model)`）：见 §4。
10. **组装请求并发送**：`LLMRequestPrep.prepare`(llm/request.ts:56) + `handle.process`(:1288)
    → `llm.stream`。详见 §5 / §6。

> ⚠️ 关键性质：**每轮都从 DB 全量重建 prompt，不做增量缓存**。所以删除/回退
> 历史后，下一次模型调用的 prompt 自然反映删除结果。

### 2.3 请求发送与 tokens 附着

`llm.stream`(llm.ts:85)：
- 解析 language model + provider 配置 + auth。
- 运行时选择：`experimentalNativeLlm` 开启时先试 native（`@opencode-ai/llm`），
  否则走 AI SDK `streamText`(:280)（含 `wrapLanguageModel` 中间件）。
- 流式事件 → `processor.process`(:640) 逐条消费。
- 回合末尾 `step-finish`(processor.ts:435-456)：`Session.getUsage` 归一化 provider
  用量 → `ctx.assistantMessage.tokens = usage.tokens` → `updateMessage` 落库 →
  发 **`message.updated`(assistant, 带 tokens)**。
- 该 usage 即右侧 sidebar "Context N tokens / P% used" 的**唯一数据源**（测量值，
  非实时计算；见 §7）。

---

## 3. 系统提示组装（prompt.ts:1273-1285 + llm/request.ts:56-99）

loop 里先取四块（均为 Effect）：

| 块 | 函数 | 内容 |
|---|---|---|
| `env` | `SystemPrompt.environment`(system.ts:67) | 模型标识 + `<env>`（cwd/worktree/git/platform/date）+ 项目 references |
| `instructions` | `Instruction.system`(instruction.ts:155) | AGENTS.md / 指令文件（按目录层级解析） |
| `mcpInstructions` | `SystemPrompt.mcp`(system.ts:119) | `<mcp_instructions>` 块（按权限过滤） |
| `skills` | `SystemPrompt.skills`(system.ts:105) | 可用 skills 详表 |

json_schema 格式会追加 STRUCTURED_OUTPUT_SYSTEM_PROMPT。

真正落到请求的 system 在 `LLMRequestPrep.prepare`(request.ts:58-78)：

```
system = [ agent.prompt ?? SystemPrompt.provider(model) ]   ← 人格/base prompt
       + [ 上面的 env/instructions/mcp/skills ]             ← loop 组装结果 (input.system)
       + [ user.system ]                                    ← 单条消息覆盖
       全部 join("\n")，再经 "experimental.chat.system.transform" 插件钩子
```

- `SystemPrompt.provider`(system.ts:27) 按模型家族返回 anthropic.txt / gpt.txt /
  gemini.txt / beast / codex / default 等。
- OpenAI OAuth 特殊路径：system 不拼成消息，放进 `options.instructions`(request.ts:99)。
- 其它 provider：system 变成前导 `role:"system"` 消息(request.ts:101-112)。

---

## 4. toModelMessagesEffect：历史 → 模型消息（message-v2.ts:131-414）

对每条 `WithParts` 转换，含大量规则：

**user 消息**：
- `text`：非空、非 `ignored` 才保留。
- `file`：text/plain 与目录文件忽略；媒体文件按 `stripMedia` 选项决定保留或降级为
  `[Attached mime: name]`；否则转 `{type:"file", url, mediaType, filename}`。
- `compaction` part → 字面量文本 `"What did we do so far?"`。
- `subtask` part → `"The following tool was executed by the user"`。
- 没有任何 part 的 user 消息直接丢弃（`:241`）。

**assistant 消息**：
- **半截过滤**(:254)：`!finish && !error && time.completed` → `continue` 不进上下文
  （用户中断的纯 thinking 半截被封存，防止模型续写旧任务）。只限 `time.completed`，
  不误伤进行中/合成的合法消息。
- **错误消息过滤**(:256-264)：有 error 且非"带实质内容的 AbortedError" → 跳过。
- **跨模型降级**(:245,362-368)：若该消息的 model ≠ 当前 model，reasoning 降级为普通
  text（签名等 provider 元数据不转发）。
- `text`：`hasSignedReasoning` 时空文本替换为单空格占位(:281-291)（保签名位置）。
- `reasoning`：同模型才保留 `type:"reasoning"` + 签名。
- `tool`（工具调用/结果）：
  - completed → `tool-<tool>` output-available，输出经 `truncateToolOutput`(:49)；
    `time.compacted` 的输出替换为 `"[Old tool result content cleared]"`。
  - error → output-error；`metadata.interrupted === true`(:337) 的**中断工具整体跳过**
    （否则模型看到"工具失败"倾向继续旧任务）。
  - pending/running → 合成 `"[Tool execution was interrupted]"` error(:350-359)。
  - 媒体附件按 provider 能力决定留在 tool result 或抽取成独立 user 消息
    (`supportsMediaInToolResult` :147-159；抽取注入 :308-313,381-398)。
- 无 part 的 assistant 消息丢弃。

最后 `convertToModelMessages`(:405-413) 产出最终 `ModelMessage[]`。

---

## 5. 请求组装：LLMRequestPrep.prepare（llm/request.ts:56-226）

- **system**：见 §3。
- **messages**：非 OpenAI-OAuth 时 = `[system 消息..., 转换后的历史...]`；
  OpenAI OAuth / workflow 直接用历史（system 走 instructions）。
- **params**（:114-132）：temperature/topP/topK/maxOutputTokens + `options`。
  `options` 合并顺序：`base(provider) → model.options → agent.options → variant`(:91)。
- **tools**（`resolveTools` :148）：OpenAI Responses 系强制 `strict:false`(:152-158)；
  Copilot 无工具但历史有 tool call 时补 `_noop`(:159-165)。
- 插件钩子：`experimental.chat.system.transform`、`chat.params`、`chat.headers`。

---

## 6. 执行：llm.stream（llm.ts:85-329）

1. `provider.getLanguage` + `config.get` + `getProvider` + `auth.get` 并行解析。
2. `LLMRequestPrep.prepare` → `prepared.{system,messages,tools,params,headers}`。
3. native 门（`flags.experimentalNativeLlm`）：`LLMNativeRuntime.stream` 返回 supported
   走 native；否则回退 AI SDK。
4. AI SDK：`streamText({ model, messages, tools, toolChoice, maxOutputTokens, ... })`，
   事件经 `LLMAISDK.toLLMEvents` 归一化后给 processor。

---

## 7. 与"删除消息 / Context 显示"的关系

- **删除消息后下一次 prompt 自动生效**：prompt 每轮从 DB 重建（§2.2-1），删除 =
  删 DB 行，因此无需任何额外逻辑，下一次模型调用天然不含被删内容。
- **右侧 sidebar Context 数字是测量值不是计算值**：它 = 最后一条 `tokens.output > 0`
  的 assistant 消息在 `step-finish`(processor.ts:445) 记录的 provider 用量之和
  （input+output+reasoning+cache.read+cache.write），显示于
  `packages/tui/src/feature-plugins/sidebar/context.tsx`。
  - 删除**最后**回合 → 锚点落到上一条 assistant，数字自动更新。
  - 删除**中段**回合 → 锚点不变，数字不动，直到下一次模型调用上报新用量自愈。
- **"真实剩余上下文"只能由服务端按本流程重算**：TUI 无法重建 system/tools/过滤规则；
  精确计数需要 provider 的 count-tokens API（Anthropic/Google）或本地 tokenizer。

---

## 8. 已知边界 / 注意事项

1. **每轮全量重建的成本**：大 session 每次调用都重读全量历史（分页 stream），
   是既有设计，勿在 loop 内做增量假设。
2. **compaction 重排**：`filterCompacted` 的输出顺序不是时间序（摘要顶替旧历史），
   任何依赖"数组即时间序"的逻辑都会被它打破。
3. **半截/中断消息过滤依赖 `time.completed` + 无 finish/error**：改中断流程时
   务必同步核对 message-v2.ts:248-254 与 :337。
4. **`convertToModelMessages` 是唯一落点**：新 part 类型要进模型上下文，必须在此
   及其对应 provider 协议里同时处理，否则静默丢失或报错。
5. **OpenAI OAuth 与 workflow 是旁路**：system 不进消息数组（instructions），
   改动组装顺序时须两路都覆盖。
6. **插件钩子**（system.transform / chat.params / chat.headers）会在组装后改写请求：
   排查"prompt 和预期不一致"时先查插件。

---

## 9. 测试覆盖

- `test/session/prompt.test.ts`：prompt 入口 / createUserMessage / loop 行为。
- `test/session/message-v2.test.ts`：半截过滤 / interrupted 工具过滤 / 未 finalize
  半截保留 / 媒体提取等转换规则。
- `test/session/compaction.test.ts`：`Token.estimate` 与压缩选择。
- `test/session/processor-effect.test.ts`：processor 事件流 / step-finish tokens。

> 跑测试：从 `packages/opencode` 目录 `bun test test/session/...`
> （不能从仓库根跑）。

# 术语对照：Message / Part / 半截 assistant

> 目的：统一后续讨论（auto-restore、rewind、中断处理等）时的术语，避免歧义。
> 核心一句话：**thinking 和输出文本都不是「消息」，它们是 assistant 消息里的「片段（part）」**。
> Schema 定义：`packages/schema/src/v1/session.ts`（Part 联合类型 :357，User :332，Assistant :453）。

## 1. 三层模型

```
Session（会话）
 └── Message（消息，role 只有两种：user / assistant）
      └── Part（片段，挂在消息下，按时间顺序排列）
```

### user message（用户消息）

- 一条提交的 prompt = 一条 user message（`role: "user"`）。
- 它下面的 parts：`text`（用户打的字）、`file`（@ 的文件）、`agent` 等。
- ⚠️ 并非所有 user message 都是用户打的 —— reminders/压缩会产生
  `synthetic: true` 的 text part（机器加的）。回填 prompt 时要过滤 `!part.synthetic`。
- Schema：`packages/schema/src/v1/session.ts:332`（User）。

### assistant message（助手消息）

- **它是容器，不是某一段内容**。模型每发起一次 LLM 请求就是一个「step」，
  产出一条 assistant message。多步轮次会有多条，都通过 `parentID` 指向同一条 user message。
- 关键字段：`parentID`（属于哪条 user 消息）、`finish`、`error`、
  `time.created/completed`、tokens/cost。
- 创建时机：**调 LLM 之前**（`packages/opencode/src/session/prompt.ts:1201`），
  所以「还没发给 LLM」时这条消息就已经存在了。

### part（片段）

完整类型列表：`packages/schema/src/v1/session.ts:357-370`。

| part 类型 | 是什么 | 对应术语 |
|---|---|---|
| `step-start` | 本步开始标记 | 无 |
| `reasoning` | 模型的思考内容（`text` 字段） | **thinking** |
| `text` | 模型给用户的可见回答 | **输出结果 / text output** |
| `tool` | 工具调用（state: pending/running/completed/error） | 工具调用 |
| `step-finish` | 本步结束标记（reason/tokens/cost） | 无 |
| `snapshot` / `patch` | 文件快照 / 文件改动 | 无 |
| `retry` | 重试记录 | 无 |
| `file` / `agent` / `subtask` / `compaction` | 用户输入侧或系统侧片段 | 无 |

`finish` 的常见取值（由 LLM step-finish 的 reason 写入，
`packages/opencode/src/session/processor.ts:435-452`）：
`"stop"`（正常结束）、`"tool-calls"`（要去执行工具，循环继续）、`"length"` 等。

## 2. 一次问答的流程

```
[user message]  role=user   text("帮我改bug") + file(@a.ts) …
      │ parentID
      ▼
[assistant message #1]  role=assistant, parentID=user.id
   parts（时间顺序）:
     step-start
     reasoning   "用户想让我…"      ← TUI 显示 "Thinking:"
     text        "我先看下文件"      ← 可见输出
     tool        read(...) running→completed
     step-finish reason="tool-calls"
   finish="tool-calls"  → 执行工具，再请求一次 LLM
      │
      ▼
[assistant message #2]  (同一个 parentID)
   parts: step-start / reasoning / text / … / step-finish
   finish="stop" → 本轮问答结束
      │
      ▼
[user message] 下一条 prompt → 下一轮
```

服务端时序（中断相关，详见 `doc/interrupt-auto-restore.md`）：

1. `createUserMessage` 落 user 消息（prompt.ts:635）。
2. `runLoop` 做准备（读历史、解析模型、reminders…）→ **创建 assistant 消息行**
   `sessions.updateMessage(msg)`（prompt.ts:1201）→ 这一步在调 LLM 之前。
3. `processor.create` → `llm.stream(...)` 开始流式产出 reasoning/text/tool parts。
4. 用户 ESC×2 → abort → `Fiber.interrupt` → finalizer 链：
   `status=idle` → `cleanup` 写 `time.completed` →
   `finalizeInterruptedAssistant` 决定 finish（prompt.ts:1203-1227）。

## 3. 术语速查

| 术语 | 精确含义 |
|---|---|
| 「thinking / 思考」 | assistant message 里的 `reasoning` part，**不是 message** |
| 「输出结果 / text output」 | 同一条 assistant message 里的 `text` part，**不是 message** |
| 「工具调用」 | assistant message 里的 `tool` part |
| 「半截 assistant」 | 被中断后**没有 `finish`/`error` 的那条 assistant message**；里面可能有 `reasoning`/`step-start`，也可能一条 part 都没有 |
| 「一轮问答 / turn」 | 1 条 user message + 它名下的所有 assistant messages（多步时多条，靠 `parentID` 关联） |
| 「回填对象」 | 那条 user message 的 parts（非 synthetic text 拼回输入串，file/agent part 还原成 @ 提及） |

## 4. 半截 assistant 的三种结局（中断 finalize 后）

| 中断时 assistant 消息状态 | finalize 结果 | 是否半截 |
|---|---|---|
| 消息未创建（中断发生在 prompt.ts:1201 之前） | 无消息 | 否（doc S5，不回填） |
| 消息在，零 parts / 只有 reasoning | 无 finish、无 error、有 time.completed | ✅ 纯 thinking 半截（被模型上下文过滤，`message-v2.ts:248-254`） |
| 已有非空 text 或 tool part | `finish="stop"` | 否（按完成保留，S2/S3） |

注意：user 消息永远不会变成半截；它只会被 auto-restore 显式删除。

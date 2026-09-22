# 中断与 auto-restore 全流程参考（run 模式 + 普通 TUI）

> 面向两个客户端：`opencode --mini` / run 直接模式（`packages/opencode/src/cli/cmd/run/`）
> 和普通 TUI（`packages/tui`）。本文是 2026-09 一次完整调查的沉淀：user 消息、
> thinking、中断、auto-restore 的端到端流程与各种场景的处理方式。
> 下次改这部分代码先读这里，不用再从头翻。

## 0. 一句话总结

ESC×2 中断任务时：若被中断的 assistant 半截**没有任何实质输出**（纯 thinking），
客户端把它连同上一条 user 消息从**服务端删除**，并把 user 的 prompt 文本
**回填到输入框**。若半截有文本或工具调用，则按正常完成对待，不回填。

- run 模式：链路在 `stream.transport.ts` 的 `autoRestoreInterruptedTurn()`
  （判定 + 删除 + 回填触发）。删除只发生在 DB/上下文，已渲染的滚动区不消失。
- 普通 TUI：链路在 `routes/session/auto-restore.ts` 的 `autoRestoreInterruptedTurn()`。
  时间线由 sync store 驱动，删除会通过 `message.removed` 直接从界面消失。
  除"纯 thinking 半截"外，**半截都还没创建就被打断（S5）也会删除 user 并回填**。

---

## 1. 关键文件 / 函数 / 行号速查

### run 模式（`packages/opencode`）

| 文件 | 关键位置 | 作用 |
|---|---|---|
| `src/cli/cmd/run/stream.transport.ts` | `runPromptTurn` :1304 | 单回合入口；记录 `state.lastUserText`(:1328)；`promptAsync` 发送(:1435-1453) |
| 同上 | `applyEvent` :982 | 每事件入口；`state.interruptedTurn` 覆盖赋值(:986-999) |
| 同上 | `autoRestoreInterruptedTurn` :889-971 | 5 道关卡 + deleteMessage + restoreDraft |
| 同上 | 调用点 1(abort 路径) :1455-1465；调用点 2(idle 路径) :1484-1502 | 回合结束两处都会触发 auto-restore |
| 同上 | `waitTurn` :240 / `mark` :861 / `complete` :847 / `touch` :838 | 回合结束机制（idle 驱动） |
| `src/cli/cmd/run/session-data.ts` | `reduceSessionData` :773 | 事件归约，维护 `data.role`(:832)/`data.part`/`data.text`/`data.tools` |
| 同上 | `hasMeaningfulOutput` :1122 | 判定半截是否有实质输出 |
| 同上 | `lastUserTurn` :1136 | 反查最后一条 user 消息（依赖 `data.role`） |
| 同上 | `bootstrapSessionData` :283 | **注意：不填 `data.role`** |
| 同上 | `flushInterrupted` :744 | 回合 abort 时冲刷半截显示 |
| `src/cli/cmd/run/footer.prompt.tsx` | `submitPrompt` :1172 / `resetDraft` :610 | 提交时清空输入框 |
| 同上 | `replaceDraft` :626 / `draftText` :642 | 回填与"用户是否在输入"判断 |
| 同上 | `bind` :700 / view 切换 effect :1271-1290 | area 绑定 / 切 view 时 `restore(draft)` |
| `src/cli/cmd/run/footer.ts` | `handleInterrupt` :986 | ESC 双击逻辑（第一下提示、第二下触发） |
| 同上 | `restoreDraft` :388 / `draftText` :393 / `onComposerReady` :348 | 桥接到 composer |
| `src/cli/cmd/run/runtime.ts` | `onInterrupt` :340 | ESC×2 → `session.abort()`（**服务端** abort，本地 signal 不触发） |
| `src/cli/cmd/run/runtime.queue.ts` | 队列循环 :120；`sent` :165-171；`run` :212 | 串行提交 |
| `src/session/prompt.ts` | `prompt` :1052 / `createUserMessage` :635 / `save` :1046 | user 消息落库+发 `message.updated` |
| 同上 | assistant 半截创建 :1186-1201 | 发 `message.updated`(assistant, 无 finish 无 error) |
| 同上 | `finalizeInterruptedAssistant` :1203-1227 | 中断后决定半截归属（有输出→stop；纯 thinking→保持无 finish） |
| `src/session/processor.ts` | `onInterrupt` :648-658 | 中断：置 `aborted`、`status.set(idle)` |
| 同上 | `cleanup` :539-597 | 补写半截 parts；运行中工具标 `interrupted:true`(:583-592)；`time.completed`(:595) |
| `src/session/message-v2.ts` | :248-254 | **半截过滤**：time.completed 且无 finish/error → 不进模型上下文 |
| 同上 | :337 | **interrupted 工具过滤**：不进模型上下文 |
| `src/server/routes/instance/httpapi/handlers/session.ts` | `abort` :232 / `promptAsync` :311 / `deleteMessage` :380 | HTTP 端点 |
| `src/cli/cmd/run/trace.ts` | env :58；文件路径 :31 | `OPENCODE_DIRECT_TRACE=1` 时写 JSONL |

### 普通 TUI（`packages/tui`）

| 文件 | 关键位置 | 作用 |
|---|---|---|
| `src/component/prompt/index.tsx` | interrupt handler :393-436（anchor :417，触发 :423） | ESC×2 → `session.abort()`，取 anchor user 消息并触发 auto-restore |
| `src/routes/session/auto-restore.ts` | `autoRestoreInterruptedTurn` :26 / `hasMeaningfulOutput` :109 / `promptInfoFromParts` :115 | 判定 + 删除 + 回填（普通 TUI 全部逻辑） |
| `src/routes/session/delete-turn.ts` | `deleteMessages` :6 / `deleteTurn` :26 | 删除消息（时间线 Delete 与 auto-restore 共用） |
| `src/context/sync.tsx` | `message.removed` :361-375 | 删除后同步 store 自动移除，时间线消失 |
| `src/component/prompt/index.tsx` | `PromptRef.set` :595 | 把重建的 PromptInfo 写回输入框（undo/revert 共用） |
| `src/prompt/part.ts` | `stripPromptPartIDs` | 回填 file/agent part 时去掉持久化 ID |

---

## 2. 完整数据流

### 2.1 提交 prompt → user 消息

1. 输入框回车 → `submitPrompt`(footer.prompt.tsx:1172)：`resetDraft()` 清空输入框(:1213)，
   `input.onSubmit(submit)` 返回 true 后 draft 保持空。
2. `runtime.queue.ts` 队列循环(:120)出队，构造 `sent = {...prompt, messageID}`(:165-171)，
   `input.run(sent, ctrl.signal)`(:212)。
3. `runtime.ts run()`(:640) → `ensureStream()` → `runPromptTurn({ prompt: sent })`。
4. transport `runPromptTurn`(stream.transport.ts:1304)：
   - `state.lastUserText = next.prompt.text`(:1328) ← auto-restore 回填的文本来源。
   - `send` = `session.promptAsync(req)`(:1440)。服务端 handler 是**先 fork 后立刻返回 200**
     (handlers/session.ts:311-329)，所以 `send` 很快 resolve，`item.armed = true`(:1450)，
     随后进入 `waitTurn` 等待 idle。
5. 服务端 `SessionPrompt.prompt`(prompt.ts:1052)：
   - `createUserMessage`(:635) → 解析 parts → `save`(:1046) `updateMessage(info)` → 发出
     **`message.updated`(role=user)** —— 这是第一条 user 事件。
   - `loop()` 开始，`status.set(busy)` → `session.status busy`。

### 2.2 assistant 半截与 thinking 生成

1. runLoop(prompt.ts:1081) 取 `lastUser` = 刚创建的 user 消息。
2. 创建 assistant `msg`(:1186-1201)，`updateMessage(msg)`(:1201) → **`message.updated`(role=assistant,
   无 finish 无 error)** —— 半截诞生，AI 侧（`interruptedTurn`）此时被置 true。
3. `processor.create({ assistantMessage: msg })`(:1229-1235)。
4. `handle.process()`(:1288) → `llm.stream(...)` 流式输出，每个部分发 `message.part.updated`：
   - reasoning（思考）→ `type:"reasoning"`（TUI 里以 "Thinking:" 前缀显示）
   - 文本 → `type:"text"`
   - 工具调用 → `type:"tool"`（运行时计入 `data.tools`）

### 2.3 transport 归约（每事件）

`applyEvent`(stream.transport.ts:982)：
- **`state.interruptedTurn = info.role === "assistant" && !info.finish && !info.error`**
  (:986-999)。⚠️ 每条 `message.updated` 都会覆盖，是脆弱点（见 §6）。
- `reduceSessionData`(session-data.ts:773)：
  - user/assistant 消息 → `data.role.set(id, role)`(:832)。
  - reasoning part → `data.part`(kind="reasoning") + `data.text`(累积)；`time.end` 后 `drop()`(:1051-1053)。
  - text part → `data.part`(kind="assistant")。
  - tool running → `data.tools.add(id)`(:937-940)。
- `touch`(:838) 在 active 事件上置 `item.live = true`(:844)（`complete` 的通行证之一）。
- `session.status idle` → `mark`(:861) → `complete`(:847) → 结束回合的 Deferred。

### 2.4 ESC×2 中断（服务端 abort，非本地）

1. 第一下 ESC → `footer.handleInterrupt`(footer.ts:986)：`interrupt=1`，提示
   "esc again to interrupt"，5s 计时器。
2. 第二下 ESC → `interrupt=2` → `onInterrupt()`(runtime.ts:340) → **`session.abort()`**。
   ⚠️ 只打服务端，**本地 AbortSignal 不触发**。回合靠服务端 `idle` 事件结束。
3. 服务端 `abort`(handlers/session.ts:232) → `promptSvc.cancel`(prompt.ts:152) →
   `state.cancel`(run-state.ts:77) → `Runner.cancel` → 打断 runLoop。

### 2.5 服务端 finalize 顺序（关键）

打断传播时的 finalizer 执行顺序决定了事件到达顺序：

1. **processor.onInterrupt**(processor.ts:648)：`aborted=true`；**`status.set(idle)`**(:657)
   → 发 **`session.status idle`**（通常第一条到）。
2. **processor.cleanup**(processor.ts:539)：
   - 补写进行中的 reasoning/text part 的 `time.end`(:555-569)。
   - 运行中工具标为 `error:"Tool execution aborted"` + `metadata.interrupted:true`(:583-592)。
   - `ctx.assistantMessage.time.completed = Date.now()`(:595) + `updateMessage`(:596)
     → **`message.updated`(assistant, 无 finish 无 error, time.completed)**。
3. **finalizeInterruptedAssistant**(prompt.ts:1203-1227，挂在 processor.create 的 onInterrupt 上)：
   - `if (msg.finish || msg.error) return`(:1208)——已有终态则不再处理。
   - 读 DB parts 算 `hasOutput = 非空 text || 有 tool`(:1219-1221)。
   - 有输出 → `msg.finish ??= "stop"`(:1223)（按正常完成对待）。
   - 纯 thinking → 不设 finish 不设 error，仅 `time.completed`(:1225)（保持"半截"身份）。
   - `updateMessage`(:1226) → **`message.updated`(assistant, 无 finish 无 error)**。

> ⚠️ idle 事件通常先于 finalize 的 `message.updated` 到达 transport。这意味着
> auto-restore 判定时可能还没看到 finalize 的那条事件，只能依赖此前的
> `interruptedTurn` 值（见 §6 脆弱点 2）。

### 2.6 回合结束 → auto-restore

transport 收到 `session.status idle` → `mark` → `complete` → `waitTurn` 返回 "idle"
→ 走 idle 调用点(stream.transport.ts:1484-1502) → `autoRestoreInterruptedTurn()`。

---

## 3. auto-restore 的判定与动作

### 3.1 run 模式（5 道关卡）

`autoRestoreInterruptedTurn`(stream.transport.ts:889-971)：

| # | 关卡 | 代码 | 说明 |
|---|---|---|---|
| 1 | `state.interruptedTurn` | :891 | 本回合最后一条 assistant 消息"无 finish 无 error"（脆弱） |
| 2 | footer 未关闭 | :898 | transport/footer 正常 |
| 3 | `draftText()` 为空 | :906 | 用户没在输入新内容，避免覆盖 |
| 4 | `state.sawOutput` 与 `hasMeaningfulOutput` 均为假 | :916 | 本回合从未产生非空 assistant 文本/工具调用（纯 thinking 才过；`sawOutput` 覆盖已结束并被 `drop` 的输出） |
| 5 | `lastUserTurn` 取到 user | :923 | `data.role` 里能找到 user 消息 |

全部通过后（非阻塞 fire-and-forget）：
1. `deleteMessage(assistantID)` + `deleteMessage(user)`(stream.transport.ts:937-962)
   —— 只删 DB/上下文，TUI 已渲染内容不消失。失败写 `turn.autoRestore.error` trace，
   **不阻断回填**。
2. `input.footer.restoreDraft(state.lastUserText ?? "")`(:970) →
   `composer.replaceDraft`(footer.prompt.tsx:626) → `area.setText(prompt)`。

> 注释里强调：必须在 `flushInterrupted`（会清空 `data`）之前调用 auto-restore。

### 3.2 普通 TUI 的判定与动作（`packages/tui/src/routes/session/auto-restore.ts`）

无 timeout、无轮询，完全由 `session.abort()` 的 HTTP 响应驱动：服务端
`Runner.cancel` 会等 `Fiber.interrupt` 的 finalizer（cleanup +
finalizeInterruptedAssistant）跑完，所以 abort resolve 时"有输出/纯 thinking"
的判定已经落库，直接从服务端拉状态即可，不受 SSE 事件顺序影响。

1. ESC×2 时记 anchor：`sync.data.message[sessionID]` 里最后一条 user 消息的 id。
2. `await abort` → `session.messages({ sessionID, limit: 100 })` 拉权威状态。
3. **归属校验**：fetch 里必须能找到 anchor 这条 user；找不到则不猜测、不处理
   （防止历史上遗留的旧 thinking 半截被误判成本轮）。
4. 逐条检查 anchor 的 assistant replies（`parentID === anchor`）：
   - 任意一条有 `finish || error`，或 parts 有非空 text/tool → 整轮已有实质输出，
     不处理（多步回合里最后一步可能只剩 reasoning，但更早步骤已有输出）；
   - 全部 reply 都没有输出 → 纯 thinking 半截，继续删除；
   - 无 reply（S5，服务端还没建半截就被打断）→ 继续，但要求 anchor 是 fetch
     里最后一条 user 消息。
5. 从 anchor 的 parts 重建 PromptInfo（非 synthetic text 拼 input + file part 去 ID）。
6. `deleteMessages([...replies, anchor])`（与时间线 Delete 同一 API）→ 服务端发
   `message.removed` → sync store 自动把该轮从时间线移除。
7. `isActive()`（没切 session）且 `inputEmpty()`（输入框为空）→
   `PromptRef.set(prompt)` 回填并定位光标。

守卫：模块级 `running` 防重入；`isActive` 防切 session 后误写输入框；
`inputEmpty` 防覆盖用户正在输入的新内容；`deleteMessages` 失败会 toast 但不阻断回填。

---

## 4. 模型上下文过滤（为什么半截不会续写旧任务）

`MessageV2.toModelMessagesEffect`(message-v2.ts)：

- **半截过滤**(:248-254)：assistant 消息满足 `!finish && !error && time.completed` →
  `continue` 不进模型上下文。这样用户输入新提示词后，模型不会把旧半截当
  "未完成回合"继续回答旧任务。
  - `time.completed` 限定很重要：只过滤"已被封存"的半截，不误伤仍在进行中
    或合成（无 time.completed）的合法 assistant 消息。
- **interrupted 工具过滤**(:337)：`part.state.metadata?.interrupted === true` → 跳过，
  不再作为 `output-error` 留给模型（否则模型会看到"工具失败"并倾向继续旧任务的工具流程）。

---

## 5. 场景矩阵（每种情况怎么处理）

| # | 场景 | 半截 finish/error | 是否删除 user+assistant | 是否回填输入框 | 模型上下文表现 |
|---|---|---|---|---|---|
| S1 | **纯 thinking 被中断**（无文本无工具） | 无 finish 无 error（time.completed） | ✅ 删除 | ✅ 回填 | 半截被过滤，不回显 |
| S2 | **有部分文本被中断** | finalize 置 `finish="stop"` | ❌ 保留 | ❌ 不回填 | 正常显示（按完成回合） |
| S3 | **有工具调用被中断** | 工具标 `interrupted:true`；因 hasOutput 置 `finish="stop"` | ❌ 保留 | ❌ 不回填 | interrupted 工具部分被过滤，文本保留 |
| S3b | **多步回合的后一步纯 thinking 被中断**（前一步已有 text/tool） | 半截本身无输出，但服务端按整轮有输出置 `finish="stop"` | ❌ 保留 | ❌ 不回填 | 半截按完成保留，前序步骤正常 |
| S4 | **正常完成** | finish=stop/tool-calls… | ❌ | ❌ | 正常 |
| S5 | **中断早于 assistant 创建** | 无半截 | run：❌（整段不进入）；TUI：✅ 删 user | run：❌；TUI：✅ 回填 | 无半截 |
| S6 | **中断时用户正在输入新内容** | 同 S1 | ✅ 删除（关卡 3 只挡回填不挡删除） | ❌ `draftText()` 非空 → 跳过回填 | 半截被过滤 |
| S7 | **footer 关闭 / transport 已关** | — | ❌ 关卡 2 拦截 | ❌ | — |
| S8 | **deleteMessage 失败** | — | ❌ 删失败（有 trace） | ✅ 仍回填 | 半截仍被过滤（无 finish/error），旧 user 短暂冗余 |

细节说明：
- S5：run 模式 `interruptedTurn` 为 false，整段不进入（assistantID 为空时删除循环
  也只删 user，stream.transport.ts:937-962）。普通 TUI 走"无 reply"分支：删除该
  user 并回填 prompt，前提是它确实是服务端最后一条 user（防止误删历史轮次）。
- S6：`draftText()` 守卫(:906) 只挡"回填"，不挡"删除"——删除照常进行，符合
  "不打扰用户正在输入的内容，但仍把旧请求从上下文拿掉"的意图。普通 TUI 同语义。
- S2/S3 语义：有实质输出 = "保留结果"而非"放弃重来"，所以不回填、不删除。
- 多步回合（S3b）：输出判定按整轮而非最后一条 reply。服务端 finalize 额外检查同一
  `parentID` 下更早的 assistant 消息（prompt.ts）；TUI 逐条回复检查；run 模式用
  `state.sawOutput` 记录本回合出现过的非空文本/工具调用（part 结束后被 `drop`
  也仍保留该标记，且不受 idle/finalize 事件顺序影响）。
- 删除可见性：run 模式的滚动区是 immutable 的，删除只在 DB/上下文；普通 TUI 的
  时间线由 sync store 驱动，`message.removed` 会让该轮直接从界面消失（预期）。

---

## 6. 已知脆弱点 / 待确认问题（改代码前必读）

1. **普通 TUI"没回填"的根因（已定位，2026-09-18）**
   - 根因：auto-restore 最初只在 run 模式实现（`fd969b35a1` 对 `packages/tui/`
     零改动）。普通 TUI 的 ESC×2（`packages/tui/src/component/prompt/index.tsx`）
     只调 `session.abort()`，没有任何判定/删除/回填逻辑，所以无论什么场景都不会回填。
   - 修复：新增 `packages/tui/src/routes/session/auto-restore.ts`，见 §3.2。
     实测（`bun dev`）：纯 thinking 中断后 DB 中该轮 user + assistant 半截被删，
     输入框回填；有正文的中断不处理。
   - 注意：普通 TUI 无 trace；判定数据来自 `session.messages`，可用 DB/接口直接核对。

2. **run 模式 `state.interruptedTurn` 竞态（输出回合已缓解，2026-09-21）**
   - 每条 `message.updated` 都覆盖赋值；只有"最后一条恰好是 assistant 无 finish
     无 error"才为 true，与 idle/finalize 事件到达顺序耦合（§2.5：idle 通常先到）。
   - 现在 gate 4 同时看回合级 `state.sawOutput`（applyEvent 从 commits 记录非空
     assistant 文本/工具，runPromptTurn 开始时重置）：只要本回合出现过输出，即使
     还没看到 finalize 的 `finish="stop"` 也不会删除回填。单靠 `hasMeaningfulOutput`
     不可靠——文本/工具 part 结束后会被 `drop`（session-data.ts），旧输出从此看不
     见；测试里的 text part 没有 `time.end`，所以覆盖不到这个场景。
   - 纯 thinking 回合 `sawOutput` 为 false，仍按 S1 删除回填。
   - 若要彻底修 gate 1：改为回合级最终判定——只跟踪 assistant 的 `{finish,error}`，
     回合结束（idle/abort 两处）再判定，user 消息不参与；或像普通 TUI 一样 abort
     后从服务端拉状态判定。

3. **run 模式 `lastUserTurn` 依赖 `data.role`，但 `bootstrapSessionData` 不填 role**
   - session-data.ts:283 只填 `data.call`/permissions/questions。
   - 当前回合的 user/assistant role 靠 live 的 `message.updated` 事件写入，正常场景有。
   - 更稳的做法：直接用 `runPromptTurn` 入参 `next.prompt.messageID`
     （runtime.queue.ts:170 已填充），不反查。普通 TUI 用 anchor user id，已避开。

4. **run 模式 UI restore 可见性**（footer.prompt.tsx:626-639）
   - `replaceDraft` 在 `area` 被销毁时只改 `draft` 变量提前 return；area 重建后靠
     `bind`→`restore(draft)`(footer.prompt.tsx:718-725) 补上。
   - view 切换 effect(:1271-1290) 在回 `prompt` view 时会 `restore(draft)`（用当前 draft，
     通常无害，但要留意时序）。
   - 若"5 关全过但输入框仍空"，重点查这里 + 调用时机。

5. **删除可见性差异**：run 模式的滚动区不回滚，删除只发生在 DB/上下文，用户可观察
   信号只有输入框回填；普通 TUI 会从时间线移除该轮（sync `message.removed`）。

---

## 7. 调试指南（trace）

现有 trace（`src/cli/cmd/run/trace.ts`）：
- 启用：`OPENCODE_DIRECT_TRACE=1`，**且必须是 run/--mini 模式**（普通 TUI 不写）。
- 位置：`~/.local/share/opencode/log/direct/<timestamp>-<pid>.jsonl`，
  另有 `latest.json` 指针。
- 关键 trace 事件：
  - `recv.event`：每条 SDK 事件（看顺序、finalize 的 finish/error 值）。
  - `turn.autoRestore`：仅在 deleteMessage 成功发起后写（= 5 关全过）。
  - `turn.autoRestore.error`：删除失败。
  - `send.prompt` / `send.prompt.ok` / `turn.end`：回合生命周期。

建议复现步骤：
1. `OPENCODE_DIRECT_TRACE=1 bun dev --mini` 启动 run 模式（`bun dev` 本身是普通 TUI）。
2. 发一个 prompt 等它进入纯 thinking，ESC×2。
3. 看 jsonl 里：idle 前最后一条 `message.updated` 的 finish/error →
   判定 `interruptedTurn`；有没有 `turn.autoRestore`。
4. 若要更细，可在 `autoRestoreInterruptedTurn` 每关卡前加一行 trace 记录
   `interruptedTurn/draftText/hasMeaningfulOutput/lastUserTurn/lastUserText`。

普通 TUI 排查（无 trace）：
- ESC×2 后看两件事：该轮是否从时间线消失、输入框是否回填。
- 判定用的权威数据来自 `session.messages`（abort resolve 时 finalize 已落库），
  可与 DB 中该 session 的 message 行直接对照。
- 若没回填，按顺序查：anchor（ESC 时 `sync.data.message` 里最后一条 user）是否
  为空、abort 是否 resolve、fetch 里能否找到 anchor、半截是否被误判为有输出、
  输入框当时是否非空、是否切了 session（`isActive`）。

---

## 8. 测试覆盖

- `test/cli/run/stream.transport.test.ts`：
  - auto-restores an interrupted pure-thinking turn into the input box and deletes it from context
  - does not auto-restore an interrupted turn that produced text
  - does not auto-restore an interrupted turn whose text part already completed（`time.end` 后 part 被 drop）
  - does not auto-restore a multi-step turn whose earlier step produced output
  - does not auto-restore an interrupted turn with a running tool
  - does not auto-restore over a non-empty draft
- `test/session/message-v2.test.ts`：半截过滤 / interrupted 工具过滤 / 未 finalize 半截保留。
- `test/session/prompt.test.ts`、`test/session/processor-effect.test.ts`：中断不设 AbortedError、
  状态回 idle；多步回合后一步被中断且整轮有输出时置 `finish="stop"`。
- 普通 TUI `packages/tui/test/routes/session/auto-restore.test.ts`：
  - 纯 thinking → 删除 replies+user 并回填
  - 整轮无输出的多步回合（全部 reply 只有 reasoning）→ 删除 replies+user 并回填
  - 有 text / 有 tool / 有 finish / 有 error / 前序 reply 有输出 → 不动
  - S5 无 reply → 删 user 并回填
  - anchor 找不到 / anchor 非最后一条 user → 不猜测、不动
  - 输入框非空 / 已切 session → 删除但跳过回填
  - abort 失败 / messages 拉取失败 → 无副作用；删除失败 → toast 但照常回填
  - 并发触发只执行一次；file part 重建去 ID、synthetic text 不计入 input

> 跑测试：run 模式从 `packages/opencode` 目录
> `bun test test/cli/run/stream.transport.test.ts`；
> 普通 TUI 从 `packages/tui` 目录
> `bun test test/routes/session/auto-restore.test.ts`（不能从仓库根跑）。

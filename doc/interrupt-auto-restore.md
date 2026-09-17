# 中断与 auto-restore 全流程参考（run 模式）

> 面向 `opencode --mini` / run 直接模式（`packages/opencode/src/cli/cmd/run/`）。
> 本文是 2026-09 一次完整调查的沉淀：user 消息、thinking、中断、auto-restore
> 的端到端流程与各种场景的处理方式。下次改这部分代码先读这里，不用再从头翻。

## 0. 一句话总结

ESC×2 中断任务时：若被中断的 assistant 半截**没有任何实质输出**（纯 thinking），
CLI 把它连同上一条 user 消息从**服务端上下文删除**（TUI 已渲染内容不动），并把
user 的 prompt 文本**回填到输入框**。若半截有文本或工具调用，则按正常完成对待，
不回填。

auto-restore 链路代码全部在：
`stream.transport.ts` 的 `autoRestoreInterruptedTurn()`（判定 + 删除 + 回填触发）。

---

## 1. 关键文件 / 函数 / 行号速查

| 文件 | 关键位置 | 作用 |
|---|---|---|
| `src/cli/cmd/run/stream.transport.ts` | `runPromptTurn` :1269 | 单回合入口；记录 `state.lastUserText`(:1293)；`promptAsync` 发送(:1400-1418) |
| 同上 | `applyEvent` :957 | 每事件入口；`state.interruptedTurn` 覆盖赋值(:961-964) |
| 同上 | `autoRestoreInterruptedTurn` :889-946 | 5 道关卡 + deleteMessage + restoreDraft |
| 同上 | 调用点 1(abort 路径) :1420-1430；调用点 2(idle 路径) :1449-1464 | 回合结束两处都会触发 auto-restore |
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

---

## 2. 完整数据流

### 2.1 提交 prompt → user 消息

1. 输入框回车 → `submitPrompt`(footer.prompt.tsx:1172)：`resetDraft()` 清空输入框(:1213)，
   `input.onSubmit(submit)` 返回 true 后 draft 保持空。
2. `runtime.queue.ts` 队列循环(:120)出队，构造 `sent = {...prompt, messageID}`(:165-171)，
   `input.run(sent, ctrl.signal)`(:212)。
3. `runtime.ts run()`(:640) → `ensureStream()` → `runPromptTurn({ prompt: sent })`。
4. transport `runPromptTurn`(stream.transport.ts:1269)：
   - `state.lastUserText = next.prompt.text`(:1293) ← auto-restore 回填的文本来源。
   - `send` = `session.promptAsync(req)`(:1405)。服务端 handler 是**先 fork 后立刻返回 200**
     (handlers/session.ts:311-329)，所以 `send` 很快 resolve，`item.armed = true`(:1415)，
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

`applyEvent`(stream.transport.ts:957)：
- **`state.interruptedTurn = info.role === "assistant" && !info.finish && !info.error`**
  (:961-964)。⚠️ 每条 `message.updated` 都会覆盖，是脆弱点（见 §6）。
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
> `interruptedTurn` 值（见 §6 脆弱点 1）。

### 2.6 回合结束 → auto-restore

transport 收到 `session.status idle` → `mark` → `complete` → `waitTurn` 返回 "idle"
→ 走 idle 调用点(stream.transport.ts:1449-1464) → `autoRestoreInterruptedTurn()`。

---

## 3. auto-restore 的 5 道关卡与动作

`autoRestoreInterruptedTurn`(stream.transport.ts:889-946)：

| # | 关卡 | 代码 | 说明 |
|---|---|---|---|
| 1 | `state.interruptedTurn` | :891 | 本回合最后一条 assistant 消息"无 finish 无 error"（脆弱） |
| 2 | footer 未关闭 | :894 | transport/footer 正常 |
| 3 | `draftText()` 为空 | :898 | 用户没在输入新内容，避免覆盖 |
| 4 | `hasMeaningfulOutput` 为假 | :904 | 无非空 assistant 文本、无进行中工具（纯 thinking 才过） |
| 5 | `lastUserTurn` 取到 user | :907 | `data.role` 里能找到 user 消息 |

全部通过后（非阻塞 fire-and-forget）：
1. `deleteMessage(assistantID)` + `deleteMessage(user)`(stream.transport.ts:920-942)
   —— 只删 DB/上下文，TUI 已渲染内容不消失。失败写 `turn.autoRestore.error` trace，
   **不阻断回填**。
2. `input.footer.restoreDraft(state.lastUserText ?? "")`(:945) →
   `composer.replaceDraft`(footer.prompt.tsx:626) → `area.setText(prompt)`。

> 注释里强调：必须在 `flushInterrupted`（会清空 `data`）之前调用 auto-restore。

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
| S4 | **正常完成** | finish=stop/tool-calls… | ❌ | ❌ | 正常 |
| S5 | **中断早于 assistant 创建** | 无半截 | ❌（assistantID 为空仍会删 user？见下） | 依赖 `interruptedTurn`（此时 false→不回填） | 无半截 |
| S6 | **中断时用户正在输入新内容** | 同 S1 | ✅ 删除（关卡 3 只挡回填不挡删除） | ❌ `draftText()` 非空 → 跳过回填 | 半截被过滤 |
| S7 | **footer 关闭 / transport 已关** | — | ❌ 关卡 2 拦截 | ❌ | — |
| S8 | **deleteMessage 失败** | — | ❌ 删失败（有 trace） | ✅ 仍回填 | 半截仍被过滤（无 finish/error），旧 user 短暂冗余 |

细节说明：
- S5 里若 `assistantID` 为 undefined，删除循环只删 user（stream.transport.ts:922-931）；
  但 `interruptedTurn` 通常为 false，整段不会进入。
- S6：`draftText()` 守卫(:898) 只挡"回填"，不挡"删除"——删除照常进行，符合
  "不打扰用户正在输入的内容，但仍把旧请求从上下文拿掉"的意图。
- S2/S3 语义：有实质输出 = "保留结果"而非"放弃重来"，所以不回填、不删除。

---

## 6. 已知脆弱点 / 待确认问题（改代码前必读）

1. **`state.interruptedTurn` 是竞态**（stream.transport.ts:961-964）
   - 每条 `message.updated` 都覆盖赋值；只有"最后一条恰好是 assistant 无 finish 无 error"
     才为 true。
   - 与 idle/finalize 的事件到达顺序耦合（§2.5：idle 通常先到）。测试用本地
     `ctrl.abort()` + 固定事件序，**测不出真实序**。
   - 若要修：改为回合级最终判定——只跟踪 assistant 的 `message.updated` 的
     `{finish,error}`，回合结束（idle/abort 两处）时再判定，user 消息不参与。
   - 现状（截至 2026-09，release-1.18.18 未改分支）：**"user msg 没回填输入框"的
     待修 bug**，根因未最终坐实，怀疑点：关卡 1（interruptedTurn 竞态）或 UI
     restore 不可见。

2. **`lastUserTurn` 依赖 `data.role`，但 `bootstrapSessionData` 不填 role**
   - session-data.ts:283 只填 `data.call`/permissions/questions。
   - 当前回合的 user/assistant role 靠 live 的 `message.updated` 事件写入，正常场景有。
   - 更稳的做法：直接用 `runPromptTurn` 入参 `next.prompt.messageID`
     （runtime.queue.ts:170 已填充），不反查。

3. **UI restore 可见性**（footer.prompt.tsx:626-639）
   - `replaceDraft` 在 `area` 被销毁时只改 `draft` 变量提前 return；area 重建后靠
     `bind`→`restore(draft)`(footer.prompt.tsx:718-725) 补上。
   - view 切换 effect(:1271-1290) 在回 `prompt` view 时会 `restore(draft)`（用当前 draft，
     通常无害，但要留意时序）。
   - 若"5 关全过但输入框仍空"，重点查这里 + 调用时机。

4. **删除在 TUI 不可见**：已渲染的滚动区不回滚，删除只发生在 DB/上下文。用户侧唯一
   可观察信号是输入框是否回填（以及下一条回复是否还续写旧任务）。

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
1. `OPENCODE_DIRECT_TRACE=1 bun dev` 启动 run 模式。
2. 发一个 prompt 等它进入纯 thinking，ESC×2。
3. 看 jsonl 里：idle 前最后一条 `message.updated` 的 finish/error →
   判定 `interruptedTurn`；有没有 `turn.autoRestore`。
4. 若要更细，可在 `autoRestoreInterruptedTurn` 每关卡前加一行 trace 记录
   `interruptedTurn/draftText/hasMeaningfulOutput/lastUserTurn/lastUserText`。

---

## 8. 测试覆盖

- `test/cli/run/stream.transport.test.ts`：
  - auto-restores an interrupted pure-thinking turn into the input box and deletes it from context
  - does not auto-restore an interrupted turn that produced text
  - does not auto-restore an interrupted turn with a running tool
  - does not auto-restore over a non-empty draft
- `test/session/message-v2.test.ts`：半截过滤 / interrupted 工具过滤 / 未 finalize 半截保留。
- `test/session/prompt.test.ts`、`test/session/processor-effect.test.ts`：中断不设 AbortedError、
  状态回 idle。

> 跑测试：从 `packages/opencode` 目录 `bun test test/cli/run/stream.transport.test.ts`
> （不能从仓库根跑）。

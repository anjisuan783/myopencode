import type { useSDK } from "../../context/sdk"
import type { useToast } from "../../ui/toast"
import type { PromptInfo } from "../../component/prompt/history"
import { stripPromptPartIDs } from "../../prompt/part"
import { deleteMessages } from "./delete-turn"

type Client = ReturnType<typeof useSDK>["client"]
type SessionMessage = NonNullable<Awaited<ReturnType<Client["session"]["messages"]>>["data"]>[number]
type SessionPart = SessionMessage["parts"][number]
type AssistantInfo = Extract<SessionMessage["info"], { role: "assistant" }>

const MESSAGE_LIMIT = 100

let running = false

// 用户 ESC×2 中断后，若本轮 assistant 是"纯 thinking 半截"（无可展示输出），
// 则删除该轮问答并把用户 prompt 回填到输入框。依赖 session.abort 的 HTTP 响应
// 已等待服务端 finalize 完成（runner cancel 会等 Fiber.interrupt 的 finalizer），
// 因此 abort resolve 后从服务端拉取的消息即为权威判定结果，无需 timeout 或轮询。
//
// 判定与删除对象都以 anchorUserID（ESC 时 TUI 里最后一条 user 消息）为准：
// - replies 中任意一条有 finish/error，或 parts 含非空 text 或 tool → 视为本回合
//   已有实质输出，不处理（多步回合里最后一步可能只剩 reasoning，但更早的步骤
//   已经有 text/tool/finish，整轮不能被当作纯 thinking 半截删除）；
// - 无 reply（服务端还没建半截就被打断，S5）→ 同样删除该 user 并回填；
// - fetch 结果里找不到 anchor（历史被清理/分页越界）→ 不猜测、不处理。
export async function autoRestoreInterruptedTurn(input: {
  sdk: ReturnType<typeof useSDK>
  toast: ReturnType<typeof useToast>
  sessionID: string
  anchorUserID: string | undefined
  abort: Promise<unknown>
  isActive: () => boolean
  inputEmpty: () => boolean
  setPrompt: (prompt: PromptInfo) => void
}): Promise<void> {
  if (running) {
    await input.abort.catch(() => {})
    return
  }

  running = true
  try {
    try {
      await input.abort
    } catch {
      return
    }

    if (!input.anchorUserID) {
      return
    }

    const result = await input.sdk.client.session
      .messages({ sessionID: input.sessionID, limit: MESSAGE_LIMIT })
      .catch(() => undefined)
    const messages = result?.data
    if (!messages) {
      return
    }

    const user = messages.find((message) => message.info.role === "user" && message.info.id === input.anchorUserID)
    if (!user) {
      return
    }

    const replies = messages.filter(
      (message): message is SessionMessage & { info: AssistantInfo } =>
        message.info.role === "assistant" && message.info.parentID === input.anchorUserID,
    )
    if (replies.length > 0) {
      if (replies.some((item) => item.info.finish || item.info.error || hasMeaningfulOutput(item.parts))) {
        return
      }
    } else {
      const lastUser = messages.findLast((message) => message.info.role === "user")
      if (lastUser?.info.id !== input.anchorUserID) {
        return
      }
    }

    const prompt = promptInfoFromParts(user.parts)
    if (!prompt.input.trim() && prompt.parts.length === 0) {
      return
    }

    await deleteMessages({
      sdk: input.sdk,
      toast: input.toast,
      sessionID: input.sessionID,
      messageIDs: [...replies.map((item) => item.info.id), user.info.id],
    })

    if (!input.isActive() || !input.inputEmpty()) {
      return
    }

    input.setPrompt(prompt)
  } finally {
    running = false
  }
}

// 与服务端 finalizeInterruptedAssistant 的 hasOutput 判定对齐：非空 text 或
// 任意 tool part 都算有实质输出。
function hasMeaningfulOutput(parts: readonly SessionPart[]) {
  return parts.some((part) => (part.type === "text" && part.text.trim().length > 0) || part.type === "tool")
}

// 从 user 消息的 parts 重建 composer 的 PromptInfo（与时间线 Revert/Fork 的
// 还原逻辑一致）：非 synthetic text 拼成 input，file part 去掉持久化 ID。
export function promptInfoFromParts(parts: readonly SessionPart[]): PromptInfo {
  return parts.reduce<PromptInfo>(
    (prompt, part) => {
      if (part.type === "text" && !part.synthetic) {
        prompt.input += part.text
      }
      if (part.type === "file") {
        prompt.parts.push(stripPromptPartIDs(part))
      }
      return prompt
    },
    { input: "", parts: [] },
  )
}

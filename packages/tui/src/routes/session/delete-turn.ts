import type { useSDK } from "../../context/sdk"
import type { useSync } from "../../context/sync"
import type { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"

export async function deleteMessages(input: {
  sdk: ReturnType<typeof useSDK>
  toast: ReturnType<typeof useToast>
  sessionID: string
  messageIDs: string[]
}) {
  try {
    for (const messageID of input.messageIDs) {
      await input.sdk.client.session.deleteMessage({ sessionID: input.sessionID, messageID }, { throwOnError: true })
    }
    return true
  } catch (error) {
    input.toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
    return false
  }
}

export async function deleteTurn(input: {
  sync: ReturnType<typeof useSync>
  sdk: ReturnType<typeof useSDK>
  toast: ReturnType<typeof useToast>
  sessionID: string
  messageID: string
}) {
  const replies = (input.sync.data.message[input.sessionID] ?? []).filter(
    (x) => x.role === "assistant" && x.parentID === input.messageID,
  )
  return deleteMessages({
    sdk: input.sdk,
    toast: input.toast,
    sessionID: input.sessionID,
    messageIDs: [...replies.map((reply) => reply.id), input.messageID],
  })
}

import { createMemo, createSignal, onMount } from "solid-js"
import { useSync } from "../../context/sync"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import type { TextPart } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { useDialog } from "../../ui/dialog"
import { useSDK } from "../../context/sdk"
import { useToast } from "../../ui/toast"
import { useTheme } from "../../context/theme"
import { useCommandShortcut } from "../../keymap"
import { deleteTurn } from "./delete-turn"

export function DialogTimeline(props: {
  sessionID: string
  onMove: (messageID: string) => void
}) {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const deleteHint = useCommandShortcut("session.timeline.delete")
  const [toDelete, setToDelete] = createSignal<string>()

  onMount(() => {
    dialog.setSize("large")
    dialog.setTranslucent(true)
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    const result = [] as DialogSelectOption<string>[]
    for (const message of messages) {
      if (message.role !== "user") continue
      const part = (sync.data.part[message.id] ?? []).find(
        (x) => x.type === "text" && !x.synthetic && !x.ignored,
      ) as TextPart
      if (!part) continue
      const isDeleting = toDelete() === message.id
      result.push({
        title: isDeleting ? `Press ${deleteHint()} again to confirm` : part.text.replace(/\n/g, " "),
        bg: isDeleting ? theme.error : undefined,
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: () => {
          props.onMove(message.id)
          dialog.clear()
        },
      })
    }
    result.reverse()
    return result
  })

  return (
    <DialogSelect
      onMove={(option) => {
        setToDelete(undefined)
        props.onMove(option.value)
      }}
      title="Timeline"
      options={options()}
      actions={[
        {
          command: "session.timeline.delete",
          title: "delete",
          onTrigger: async (option) => {
            if (toDelete() !== option.value) {
              setToDelete(option.value)
              return
            }
            setToDelete(undefined)
            await deleteTurn({
              sync,
              sdk,
              toast,
              sessionID: props.sessionID,
              messageID: option.value,
            })
          },
        },
      ]}
    />
  )
}

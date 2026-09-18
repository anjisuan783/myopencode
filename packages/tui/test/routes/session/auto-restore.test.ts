import { describe, expect, test } from "bun:test"
import type { useSDK } from "../../../src/context/sdk"
import type { useToast } from "../../../src/ui/toast"
import { autoRestoreInterruptedTurn, promptInfoFromParts } from "../../../src/routes/session/auto-restore"
import type { PromptInfo } from "../../../src/prompt/history"

type Sdk = ReturnType<typeof useSDK>
type Toast = ReturnType<typeof useToast>

type Fixture = {
  info: {
    id: string
    role: "user" | "assistant"
    parentID?: string
    finish?: string
    error?: unknown
  }
  parts: Array<Record<string, unknown>>
}

function user(id: string, parts: Fixture["parts"] = [{ type: "text", text: "fix the bug" }]): Fixture {
  return { info: { id, role: "user" }, parts }
}

function assistant(
  id: string,
  parentID: string,
  options: { parts?: Fixture["parts"]; finish?: string; error?: unknown } = {},
): Fixture {
  return {
    info: {
      id,
      role: "assistant",
      parentID,
      ...(options.finish ? { finish: options.finish } : {}),
      ...(options.error ? { error: options.error } : {}),
    },
    parts: options.parts ?? [{ type: "reasoning", text: "thinking" }],
  }
}

function defer<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function harness(input: { messages: Fixture[]; messagesError?: boolean; deleteError?: boolean }) {
  let messagesCalls = 0
  const deleted: string[] = []
  const toasts: string[] = []
  const sdk = {
    client: {
      session: {
        abort: async () => ({ data: true }),
        messages: async () => {
          messagesCalls += 1
          if (input.messagesError) {
            throw new Error("messages failed")
          }
          return { data: input.messages }
        },
        deleteMessage: async ({ messageID }: { messageID: string }) => {
          deleted.push(messageID)
          if (input.deleteError) {
            throw new Error("delete failed")
          }
          return { data: true }
        },
      },
    },
  } as unknown as Sdk
  const toast = {
    show: (options: { message: string }) => {
      toasts.push(options.message)
    },
  } as unknown as Toast

  return {
    sdk,
    toast,
    deleted,
    toasts,
    get messagesCalls() {
      return messagesCalls
    },
  }
}

async function run(input: {
  messages: Fixture[]
  anchorUserID?: string | null
  abort?: () => Promise<unknown>
  messagesError?: boolean
  deleteError?: boolean
  isActive?: boolean
  inputEmpty?: boolean
}) {
  const h = harness(input)
  const prompts: PromptInfo[] = []
  await autoRestoreInterruptedTurn({
    sdk: h.sdk,
    toast: h.toast,
    sessionID: "ses-1",
    anchorUserID: input.anchorUserID === null ? undefined : (input.anchorUserID ?? "msg-user"),
    abort: (input.abort ?? (async () => ({ data: true })))(),
    isActive: () => input.isActive ?? true,
    inputEmpty: () => input.inputEmpty ?? true,
    setPrompt: (prompt) => prompts.push(prompt),
  })
  return { ...h, prompts }
}

describe("auto-restore interrupted turn", () => {
  test("deletes a pure-thinking turn and restores the prompt", async () => {
    const h = await run({ messages: [user("msg-user"), assistant("msg-a", "msg-user")] })

    expect(h.deleted).toEqual(["msg-a", "msg-user"])
    expect(h.prompts).toEqual([{ input: "fix the bug", parts: [] }])
  })

  test("deletes every reply of a multi-step turn", async () => {
    const h = await run({
      messages: [
        user("msg-user"),
        assistant("msg-a1", "msg-user", { finish: "tool-calls", parts: [{ type: "tool" }] }),
        assistant("msg-a2", "msg-user"),
      ],
    })

    expect(h.deleted).toEqual(["msg-a1", "msg-a2", "msg-user"])
    expect(h.prompts).toEqual([{ input: "fix the bug", parts: [] }])
  })

  test("keeps an interrupted turn that produced text", async () => {
    const h = await run({
      messages: [
        user("msg-user"),
        assistant("msg-a", "msg-user", { parts: [{ type: "text", text: "partial answer" }] }),
      ],
    })

    expect(h.deleted).toEqual([])
    expect(h.prompts).toEqual([])
  })

  test("keeps an interrupted turn that produced a tool call", async () => {
    const h = await run({
      messages: [user("msg-user"), assistant("msg-a", "msg-user", { parts: [{ type: "tool" }] })],
    })

    expect(h.deleted).toEqual([])
    expect(h.prompts).toEqual([])
  })

  test("keeps a finished turn", async () => {
    const h = await run({
      messages: [user("msg-user"), assistant("msg-a", "msg-user", { finish: "stop" })],
    })

    expect(h.deleted).toEqual([])
    expect(h.prompts).toEqual([])
  })

  test("keeps an errored turn", async () => {
    const h = await run({
      messages: [user("msg-user"), assistant("msg-a", "msg-user", { error: { name: "UnknownError" } })],
    })

    expect(h.deleted).toEqual([])
    expect(h.prompts).toEqual([])
  })

  test("deletes the user message when the turn was interrupted before any reply", async () => {
    const h = await run({ messages: [user("msg-user")] })

    expect(h.deleted).toEqual(["msg-user"])
    expect(h.prompts).toEqual([{ input: "fix the bug", parts: [] }])
  })

  test("ignores a stale assistant half whose parent is not the anchor", async () => {
    const h = await run({
      messages: [
        user("msg-old", [{ type: "text", text: "old prompt" }]),
        assistant("msg-stale", "msg-old"),
        user("msg-user"),
      ],
    })

    expect(h.deleted).toEqual(["msg-user"])
    expect(h.prompts).toEqual([{ input: "fix the bug", parts: [] }])
  })

  test("does not guess when the anchor user message is missing", async () => {
    const h = await run({
      messages: [user("msg-old", [{ type: "text", text: "old prompt" }]), assistant("msg-stale", "msg-old")],
      anchorUserID: "msg-user",
    })

    expect(h.deleted).toEqual([])
    expect(h.messagesCalls).toBe(1)
    expect(h.prompts).toEqual([])
  })

  test("does not fetch or delete without an anchor", async () => {
    const h = await run({ messages: [user("msg-user")], anchorUserID: null })

    expect(h.messagesCalls).toBe(0)
    expect(h.deleted).toEqual([])
    expect(h.prompts).toEqual([])
  })

  test("skips the restore but still deletes when the input has content", async () => {
    const h = await run({ messages: [user("msg-user"), assistant("msg-a", "msg-user")], inputEmpty: false })

    expect(h.deleted).toEqual(["msg-a", "msg-user"])
    expect(h.prompts).toEqual([])
  })

  test("skips the restore when the session is no longer active", async () => {
    const h = await run({ messages: [user("msg-user"), assistant("msg-a", "msg-user")], isActive: false })

    expect(h.deleted).toEqual(["msg-a", "msg-user"])
    expect(h.prompts).toEqual([])
  })

  test("does nothing when the abort request fails", async () => {
    const h = await run({
      messages: [user("msg-user"), assistant("msg-a", "msg-user")],
      abort: async () => {
        throw new Error("abort failed")
      },
    })

    expect(h.messagesCalls).toBe(0)
    expect(h.deleted).toEqual([])
    expect(h.prompts).toEqual([])
  })

  test("does nothing when fetching messages fails", async () => {
    const h = await run({ messages: [user("msg-user"), assistant("msg-a", "msg-user")], messagesError: true })

    expect(h.deleted).toEqual([])
    expect(h.prompts).toEqual([])
  })

  test("restores the prompt even when deleting fails", async () => {
    const h = await run({
      messages: [user("msg-user"), assistant("msg-a", "msg-user")],
      deleteError: true,
    })

    expect(h.deleted).toEqual(["msg-a"])
    expect(h.toasts).toEqual(["delete failed"])
    expect(h.prompts).toEqual([{ input: "fix the bug", parts: [] }])
  })

  test("collapses concurrent restores into one", async () => {
    const gate = defer<void>()
    const first = run({
      messages: [user("msg-user"), assistant("msg-a", "msg-user")],
      abort: () => gate.promise,
    })
    const second = run({ messages: [user("msg-user"), assistant("msg-a", "msg-user")] })

    gate.resolve()
    const [a, b] = await Promise.all([first, second])

    expect(a.deleted).toEqual(["msg-a", "msg-user"])
    expect(b.deleted).toEqual([])
    expect(b.messagesCalls).toBe(0)
    expect(a.prompts).toEqual([{ input: "fix the bug", parts: [] }])
    expect(b.prompts).toEqual([])
  })
})

describe("promptInfoFromParts", () => {
  test("rebuilds input text and strips persisted file part IDs", () => {
    const prompt = promptInfoFromParts([
      { type: "text", text: "read " },
      { type: "text", text: "ignored", synthetic: true },
      { type: "text", text: "@doc/a.md" },
      {
        type: "file",
        id: "prt_1",
        sessionID: "ses-1",
        messageID: "msg-user",
        mime: "text/plain",
        filename: "a.md",
        url: "file:///tmp/a.md",
      },
    ] as never)

    expect(prompt).toEqual({
      input: "read @doc/a.md",
      parts: [{ type: "file", mime: "text/plain", filename: "a.md", url: "file:///tmp/a.md" }],
    })
  })

  test("returns an empty prompt for synthetic-only parts", () => {
    expect(promptInfoFromParts([{ type: "text", text: "reminder", synthetic: true }] as never)).toEqual({
      input: "",
      parts: [],
    })
  })
})

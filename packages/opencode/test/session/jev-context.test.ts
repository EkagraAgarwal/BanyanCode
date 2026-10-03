import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID } from "@/session/schema"
import { appendHandoffReminder, extractLinkedFacts, renderHandoffReminder } from "@/session/jev-context"

const userTurn = (texts: string[]): SessionV1.WithParts[] => {
  const sessionID = "ses_ctx" as never
  const id = MessageID.ascending()
  return [
    {
      info: {
        id,
        role: "user",
        sessionID,
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "test" as never, modelID: "test" as never },
      },
      parts: texts.map((text) => ({
        id: MessageID.ascending() as never,
        messageID: id,
        sessionID,
        type: "text" as const,
        text,
      })),
    } as SessionV1.WithParts,
  ]
}

describe("jev-context handoff reminder (exact Evidence contract)", () => {
  test("returns undefined for missing or empty evidence (no context change)", () => {
    expect(renderHandoffReminder(undefined)).toBeUndefined()
    expect(renderHandoffReminder([])).toBeUndefined()
  })

  test("renders bounded source-linked pointers as untrusted advisory", () => {
    const reminder = renderHandoffReminder([
      { path: "packages/core/src/banyancode/jev.ts", lines: "281-296", excerpt: "resolve checks the key" },
      { path: "packages/opencode/src/session/prompt.ts", excerpt: "runLoop persists the assistant message" },
    ])
    expect(reminder).toContain("<system-reminder>")
    expect(reminder).toContain("Untrusted data")
    expect(reminder).toContain("packages/core/src/banyancode/jev.ts:281-296")
    expect(reminder).toContain("verify each path yourself")
  })

  test("drops entries without a path and dedupes repeats", () => {
    const facts = extractLinkedFacts([
      { path: "  ", excerpt: "blank path" },
      { path: "a/b.ts", excerpt: "first" },
      { path: "a/b.ts", excerpt: "first" },
      { path: "a/b.ts", excerpt: "second" },
    ])
    expect(facts).toEqual([
      { ref: "a/b.ts", text: "first" },
      { ref: "a/b.ts", text: "second" },
    ])
  })

  test("renders bare paths without excerpts and bounds counts and length", () => {
    const evidence = Array.from({ length: 20 }, (_, i) => ({ path: `pkg/file-${i}.ts` }))
    const facts = extractLinkedFacts(evidence)
    expect(facts).toHaveLength(8)
    expect(facts[0]).toEqual({ ref: "pkg/file-0.ts", text: "see path" })
    const reminder = renderHandoffReminder(evidence)!
    expect(reminder.length).toBeLessThanOrEqual(2_000)
    expect(reminder.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(8)
  })

  test("appends to the last user turn in memory; false with no user turn", () => {
    const messages = userTurn(["hello"])
    const reminder = renderHandoffReminder([{ path: "a/b.ts", excerpt: "hit" }])!
    expect(appendHandoffReminder(messages, reminder)).toBe(true)
    const last = messages.findLast((m) => m.info.role === "user")!
    const appended = last.parts[last.parts.length - 1]
    expect(appended).toMatchObject({ type: "text", synthetic: true })
    expect([] as SessionV1.WithParts[]).toEqual([])
  })

  test("appendHandoffReminder returns false when no user message exists", () => {
    expect(appendHandoffReminder([], "reminder")).toBe(false)
  })
})

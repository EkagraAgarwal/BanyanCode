/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { ModelInfo, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { ContextBreakdownPanel, tokenSegments } from "../src/components/sidebar/context-breakdown"
import { allocateBarWidths, categorizeTokens, estimateTokens, formatTokensCompact } from "../src/data/tokens"
import { context, mount, session } from "./harness"

function assistant(input: {
  readonly id: string
  readonly input: number
  readonly output?: number
  readonly reasoning?: number
  readonly tools?: ReadonlyArray<{ readonly name: string; readonly text?: string; readonly prompt?: string }>
}): SessionMessageAssistant {
  return {
    id: input.id,
    type: "assistant",
    agent: "build",
    model: { providerID: "provider", id: "model" },
    time: { created: 1_000, completed: 2_000 },
    tokens: {
      input: input.input,
      output: input.output ?? 0,
      reasoning: input.reasoning ?? 0,
      cache: { read: 0, write: 0 },
    },
    content: (input.tools ?? []).map((tool, index) => ({
      type: "tool" as const,
      id: `tool_${input.id}_${index}`,
      name: tool.name,
      state: {
        status: "completed" as const,
        input: (tool.prompt === undefined ? { filePath: "src/a.ts" } : { prompt: tool.prompt }) as Record<
          string,
          string
        >,
        content: [{ type: "text" as const, text: tool.text ?? "" }],
      },
      time: { created: 1_000 },
    })),
  }
}

const model = {
  id: "model",
  modelID: "model",
  providerID: "provider",
  name: "Model",
  limit: { context: 100_000, output: 8_000 },
} as unknown as ModelInfo

const messages: SessionMessageInfo[] = [
  { id: "msg_user", type: "user", time: { created: 1_000 }, text: "u".repeat(400) },
  assistant({
    id: "msg_a1",
    input: 1_000,
    output: 200,
    reasoning: 100,
    tools: [{ name: "read", text: "x".repeat(400) }],
  }),
  assistant({ id: "msg_a2", input: 2_000, output: 50, tools: [{ name: "bash", text: "y".repeat(400) }] }),
]

test("token heuristics split files and tools the way the sidebar legend expects", () => {
  expect(estimateTokens("")).toBe(0)
  expect(estimateTokens("abcde")).toBe(2)
  expect(formatTokensCompact(1_000)).toBe("1k")
  expect(formatTokensCompact(1_200)).toBe("1.2k")
  expect(formatTokensCompact(2_000_000)).toBe("2M")

  const breakdown = categorizeTokens(messages)!
  expect(breakdown.userMessages).toBe(100)
  expect(breakdown.thinking).toBe(100)
  expect(breakdown.output).toBe(250)
  expect(breakdown.files).toBeGreaterThan(100)
  expect(breakdown.tools).toBeGreaterThan(100)
  expect(breakdown.subagents).toBe(0)
  expect(breakdown.total).toBe(2_350)
  expect(breakdown.model).toEqual({ providerID: "provider", id: "model" })
  expect(categorizeTokens([])).toBeUndefined()
})

test("bar allocation spends exactly the used columns", () => {
  const widths = allocateBarWidths([{ tokens: 50 }, { tokens: 50 }], 100, 200, 10)
  expect(widths.reduce((sum, width) => sum + width, 0)).toBe(5)
  expect(allocateBarWidths([], 0, 100, 10)).toEqual([])
})

test("context breakdown renders the v1 legend with tokens and percent", async () => {
  const root = session({ id: "ses_tokens", title: "tokens" })
  const app = await mount(
    () => (
      <box width={40}>
        <ContextBreakdownPanel
          context={context({ sessions: [root], messages: { ses_tokens: messages }, models: [model] })}
          sessionID="ses_tokens"
        />
      </box>
    ),
    { width: 40, height: 20 },
  )
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("CONTEXT")
    expect(frame).toContain("/ 100k (2%)")
    expect(frame).toContain("User")
    expect(frame).toContain("Thinking")
    expect(frame).toContain("Other")
    expect(frame).toContain("Files")
    expect(frame).toContain("Tools")
    expect(frame).toContain("Output")
  } finally {
    app.renderer.destroy()
  }
})

test("context breakdown stays hidden until a turn has token data", async () => {
  const root = session({ id: "ses_empty", title: "empty" })
  const app = await mount(
    () => (
      <box width={40}>
        <ContextBreakdownPanel context={context({ sessions: [root] })} sessionID="ses_empty" />
      </box>
    ),
    { width: 40, height: 10 },
  )
  try {
    expect(app.captureCharFrame().trim()).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("token segments keep the v1 order and colors", () => {
  const breakdown = categorizeTokens(messages)!
  const segments = tokenSegments(breakdown)
  expect(segments.map((segment) => segment.label)).toEqual([
    "User",
    "Thinking",
    "Other",
    "Files",
    "Tools",
    "Subagents",
    "Output",
  ])
  expect(segments.find((segment) => segment.key === "thinking")?.color).toBe("accent")
  expect(segments.find((segment) => segment.key === "files")?.color).toBe("success")
})

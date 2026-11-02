/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { ModelInfo, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { ContextBreakdownPanel, tokenSegments } from "../src/components/sidebar/context-breakdown"
import { SystemPanel } from "../src/components/sidebar/system-status"
import { allocateBarWidths, categorizeTokens, estimateTokens, formatTokensCompact } from "../src/data/tokens"
import { context, mount, session, systemLive, theme } from "./harness"

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

const surfaceHigh = RGBA.fromInts(9, 9, 9)

// Distinct colors per bar bucket so the captured spans show where the bar ends.
const barTheme = {
  ...theme,
  text: {
    ...theme.text,
    muted: RGBA.fromInts(11, 11, 11),
    feedback: {
      error: { ...theme.text.feedback.error, base: RGBA.fromInts(12, 12, 12) },
      warning: { ...theme.text.feedback.warning, base: RGBA.fromInts(13, 13, 13) },
      success: { ...theme.text.feedback.success, base: RGBA.fromInts(14, 14, 14) },
      info: { ...theme.text.feedback.info, base: RGBA.fromInts(15, 15, 15) },
    },
  },
  hue: {
    ...theme.hue,
    interactive: { ...theme.hue.interactive, 300: RGBA.fromInts(16, 16, 16) },
    accent: { ...theme.hue.accent, 300: RGBA.fromInts(17, 17, 17) },
  },
  background: { ...theme.background, raised: { ...theme.background.raised, high: surfaceHigh } },
} as unknown as Context["theme"]

function backgroundCells(app: Awaited<ReturnType<typeof mount>>, row: number) {
  const line = app.captureSpans().lines[row]!
  const cells: string[] = []
  for (const span of line.spans) {
    const color = span.bg.toInts()
    for (let index = 0; index < span.width; index++) cells.push(`${color[0]},${color[1]},${color[2]}`)
  }
  return cells
}

const surfaceKey = "9,9,9"

function contextPanel(width: number) {
  return mount(
    () => (
      <box width={width}>
        <ContextBreakdownPanel
          context={{
            ...context({
              sessions: [session({ id: "ses_tokens", title: "tokens" })],
              messages: { ses_tokens: messages },
              models: [model],
            }),
            theme: barTheme,
          }}
          sessionID="ses_tokens"
        />
      </box>
    ),
    { width, height: 20 },
  )
}

const systemStatus = {
  cpuPercent: 12,
  memoryUsedBytes: 4 * 1024 ** 3,
  memoryTotalBytes: 16 * 1024 ** 3,
  diskUsedBytes: 100 * 1024 ** 3,
  diskTotalBytes: 500 * 1024 ** 3,
  platform: "windows" as const,
}

function systemPanel(width: number) {
  return mount(
    () => (
      <box width={width}>
        <SystemPanel
          context={{ ...context(), theme: barTheme }}
          system={systemLive({ status: systemStatus })}
        />
      </box>
    ),
    { width, height: 20 },
  )
}

test("context bar stretches to the panel width at every sidebar width", async () => {
  for (const width of [30, 48]) {
    const app = await contextPanel(width)
    try {
      await app.renderOnce()
      const bar = backgroundCells(app, 1)
      expect(bar).toHaveLength(width)
      expect(bar[width - 1]).toBe(surfaceKey)
      expect(bar[0]).not.toBe(surfaceKey)
      // No gaps or overflow: every column belongs to a segment or the empty tail.
      const blank = backgroundCells(app, 19)![0]!
      expect(bar.every((cell) => cell !== blank)).toBe(true)
      expect(new Set(bar).size).toBeGreaterThan(2)
    } finally {
      app.renderer.destroy()
    }
  }
})

test("context bar and system meters share the same right edge", async () => {
  for (const width of [30, 48]) {
    const contextApp = await contextPanel(width)
    const systemApp = await systemPanel(width)
    try {
      await contextApp.renderOnce()
      await systemApp.renderOnce()
      const contextBar = backgroundCells(contextApp, 1)
      expect(contextBar[width - 1]).toBe(surfaceKey)

      const meterRows = Array.from({ length: 20 }, (_, row) => backgroundCells(systemApp, row)).filter(
        (cells) => cells[width - 1] === surfaceKey,
      )
      expect(meterRows.length).toBeGreaterThanOrEqual(3)
      // Every meter ends in the same column as the context bar.
      expect(meterRows.every((cells) => cells[width - 1] === contextBar[width - 1])).toBe(true)
      const blank = backgroundCells(systemApp, 19)![0]!
      expect(meterRows.every((cells) => cells.every((cell) => cell !== blank))).toBe(true)
    } finally {
      contextApp.renderer.destroy()
      systemApp.renderer.destroy()
    }
  }
})

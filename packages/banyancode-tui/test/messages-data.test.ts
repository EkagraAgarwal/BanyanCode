import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import {
  currentTool,
  elapsedMs,
  latestOutput,
  returnedSummary,
  runningToolCount,
  toolArgs,
  toolHistory,
} from "../src/data/messages"
import { formatDuration } from "../src/data/format"

const tool = (input: {
  readonly id: string
  readonly name: string
  readonly state: unknown
  readonly created?: number
  readonly completed?: number
}) => ({
  type: "tool" as const,
  id: input.id,
  name: input.name,
  state: input.state,
  time: { created: input.created ?? 1_000, completed: input.completed },
})

const assistant = (content: ReadonlyArray<unknown>, input: { id?: string; created?: number; completed?: number } = {}) =>
  ({
    id: input.id ?? "msg_a",
    type: "assistant",
    agent: "coder",
    model: { providerID: "test", id: "model" },
    time: { created: input.created ?? 1_000, completed: input.completed ?? 2_000 },
    content,
  }) as unknown as SessionMessageInfo

const user = (created: number, text = "do the thing") =>
  ({ id: `msg_u${created}`, type: "user", time: { created }, text }) as unknown as SessionMessageInfo

const messages = [
  user(500),
  assistant(
    [
      tool({ id: "t1", name: "read", state: { status: "completed", input: { filePath: "packages/x.ts" }, content: [] } }),
      tool({ id: "t2", name: "edit", state: { status: "error", input: { path: "src/a.ts" }, error: { type: "x", message: "boom" } } }),
      tool({ id: "t3", name: "bash", state: { status: "running", input: { command: "bun test" }, metadata: {} } }),
      tool({ id: "t4", name: "grep", state: { status: "streaming", input: '{"pattern":"needle"' } }),
    ],
    { id: "msg_a1", created: 800, completed: 1_500 },
  ),
  assistant(
    [
      { type: "reasoning", text: "thinking about the installer" },
      { type: "text", text: "Root cause: the shim trusted the  first\n  hoisted copy.\nIt now compares versions." },
    ],
    { id: "msg_a2", created: 1_200 },
  ),
]

test("tool history keeps order, arguments and state", () => {
  const history = toolHistory(messages)
  expect(history.map((call) => [call.name, call.args, call.status])).toEqual([
    ["read", "packages/x.ts", "completed"],
    ["edit", "src/a.ts", "error"],
    ["bash", "bun test", "running"],
    ["grep", '{"pattern":"needle"', "pending"],
  ])
  expect(history[0]!.completedAt).toBeUndefined()
})

test("current tool is the executing call, falling back to a streaming one", () => {
  expect(currentTool(messages)?.id).toBe("t3")
  const streaming = assistant([
    tool({ id: "t5", name: "grep", state: { status: "streaming", input: '{"pattern":"x"' } }),
  ])
  expect(currentTool([streaming])?.id).toBe("t5")
  expect(currentTool([messages[0]!])).toBeUndefined()
  expect(runningToolCount(messages)).toBe(1)
})

test("tool arguments prefer the identifying key and collapse whitespace", () => {
  expect(toolArgs({ path: "a.ts", command: "ls -la" })).toBe("a.ts")
  expect(toolArgs({ command: "ls   -la\n." })).toBe("ls -la .")
  expect(toolArgs({ count: 3 })).toBe("3")
  expect(toolArgs({ nested: { a: 1 } })).toBe("")
  expect(toolArgs(undefined)).toBe("")
  expect(toolArgs({ prompt: "x".repeat(100) }, 10)).toBe("xxxxxxxxx…")
})

test("latest output uses assistant text, then reasoning, and is empty otherwise", () => {
  expect(latestOutput(messages)).toEqual([
    "Root cause: the shim trusted the  first",
    "hoisted copy.",
    "It now compares versions.",
  ])
  expect(latestOutput(messages, 2)).toEqual(["hoisted copy.", "It now compares versions."])
  expect(latestOutput([messages[0]!])).toEqual([])
  const reasoningOnly = assistant([{ type: "reasoning", text: "just thinking" }])
  expect(latestOutput([reasoningOnly])).toEqual(["just thinking"])
  // A blank assistant message is not narration: render nothing.
  expect(latestOutput([assistant([{ type: "text", text: "   " }])])).toEqual([])
})

test("returned summary is the last assistant text, truncated, and undefined when absent", () => {
  expect(returnedSummary(messages)).toBe(
    "Root cause: the shim trusted the first hoisted copy. It now compares versions.",
  )
  expect(returnedSummary(messages, 10)).toBe("Root caus…")
  expect(returnedSummary([messages[0]!])).toBeUndefined()
  expect(returnedSummary([assistant([{ type: "reasoning", text: "only thinking" }])])).toBeUndefined()
})

test("elapsed time starts at the last prompt", () => {
  expect(elapsedMs(messages, 4_500)).toBe(4_000)
  expect(elapsedMs([], 4_500)).toBeUndefined()
  expect(elapsedMs([assistant([], { created: 3_000 })], 4_000)).toBe(1_000)
  expect(formatDuration(9_000)).toBe("9s")
  expect(formatDuration(64_000)).toBe("1m 04s")
  expect(formatDuration(3_780_000)).toBe("1h 03m")
})

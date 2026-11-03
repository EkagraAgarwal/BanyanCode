import { expect, test } from "bun:test"
import type {
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client"
import { rosterRows, type RosterRow } from "../src/data/understory"
import {
  agentSpans,
  durationText,
  nowText,
  rowAt,
  spanAt,
  staleEdits,
  stateAt,
  tokenBuckets,
  toolCountAt,
  SPAN_CAP_PER_SESSION,
  type AgentSpan,
} from "../src/data/understory-spans"
import { understoryFixture, type UnderstorySpec } from "./fixture/understory"

const tokens = (output: number, reasoning = 0) => ({
  input: 1_000,
  output,
  reasoning,
  cache: { read: 0, write: 0 },
})

interface ToolInput {
  readonly id: string
  readonly name: string
  readonly created: number
  readonly ran?: number | undefined
  readonly completed?: number | undefined
  readonly state?: "running" | "completed" | "error" | undefined
  readonly input?: Record<string, unknown> | undefined
  readonly files?: ReadonlyArray<{ readonly file: string; readonly additions: number; readonly deletions: number }> | undefined
  readonly error?: string | undefined
}

function tool(part: ToolInput): SessionMessageAssistantTool {
  const args = part.input ?? { filePath: "packages/cli/script/postinstall.mjs" }
  const status = part.state ?? (part.completed === undefined ? "running" : "completed")
  const metadata = part.files === undefined ? {} : { files: part.files }
  const state =
    status === "completed"
      ? { status: "completed" as const, input: args, content: [{ type: "text" as const, text: "" }], metadata }
      : status === "error"
        ? {
            status: "error" as const,
            input: args,
            error: { type: "fixture", message: part.error ?? "failed" },
            metadata,
          }
        : { status: "running" as const, input: args, metadata }
  return {
    type: "tool",
    id: part.id,
    name: part.name,
    state,
    time: {
      created: part.created,
      ...(part.ran === undefined ? {} : { ran: part.ran }),
      ...(part.completed === undefined ? {} : { completed: part.completed }),
    },
  } as SessionMessageAssistantTool
}

function think(text: string, created: number, completed?: number): SessionMessageAssistantReasoning {
  return {
    type: "reasoning",
    text,
    time: { created, ...(completed === undefined ? {} : { completed }) },
  }
}

function write(text: string): SessionMessageAssistantText {
  return { type: "text", text }
}

function assistant(input: {
  readonly id: string
  readonly created: number
  readonly completed?: number | undefined
  readonly streamed?: number | undefined
  readonly tokens?: ReturnType<typeof tokens> | undefined
  readonly retry?: { readonly attempt: number; readonly at: number; readonly message: string } | undefined
  readonly content?:
    | ReadonlyArray<SessionMessageAssistantText | SessionMessageAssistantReasoning | SessionMessageAssistantTool>
    | undefined
}): SessionMessageInfo {
  return {
    id: input.id,
    type: "assistant",
    agent: "coder",
    model: { providerID: "provider", id: "model" },
    time: {
      created: input.created,
      ...(input.streamed === undefined ? {} : { streamed: input.streamed }),
      ...(input.completed === undefined ? {} : { completed: input.completed }),
    },
    content: [...(input.content ?? [])],
    ...(input.tokens === undefined ? {} : { tokens: input.tokens }),
    ...(input.retry === undefined
      ? {}
      : {
          retry: {
            attempt: input.retry.attempt,
            at: input.retry.at,
            error: { type: "provider", message: input.retry.message },
          },
        }),
  } as unknown as SessionMessageInfo
}

function row(spec: UnderstorySpec, extra: readonly UnderstorySpec[] = []): RosterRow {
  const fixture = understoryFixture({ specs: [spec, ...extra] })
  const killed = new Set(spec.killed === true || spec.state === "killed" ? [spec.id] : [])
  const rows = rosterRows({
    root: "ses_root",
    sessions: fixture.sessions,
    killed,
    pending: (id) => (id === spec.id ? (spec.pending ?? 0) : 0),
    messages: (id) => fixture.messages[id] ?? [],
  })
  const found = rows.find((item) => item.sessionID === spec.id)
  if (found === undefined) throw new Error(`missing row ${spec.id}`)
  return found
}

test("tool parts become ordered spans with real times, letters, files and diffs", () => {
  const spans = agentSpans([
    assistant({
      id: "msg_a",
      created: 50,
      completed: 4_000,
      content: [
        tool({ id: "t1", name: "read", created: 60, ran: 100, completed: 900 }),
        tool({
          id: "t2",
          name: "edit",
          created: 950,
          ran: 1_000,
          completed: 2_200,
          input: { filePath: "packages/cli/script/postinstall.mjs" },
          files: [{ file: "packages/cli/script/postinstall.mjs", additions: 4, deletions: 1 }],
        }),
        tool({
          id: "t3",
          name: "bash",
          created: 2_300,
          ran: 3_000,
          input: { command: "npm pack --dry-run" },
        }),
      ],
    }),
  ])

  expect(spans.map((span) => [span.kind, span.name, span.letter, span.t0, span.t1])).toEqual([
    ["tool", "read", "R", 100, 900],
    ["tool", "edit", "E", 1_000, 2_200],
    ["tool", "shell", "$", 3_000, undefined],
  ])
  expect(spans[0]!.file).toBe("packages/cli/script/postinstall.mjs")
  expect(spans[0]!.target).toBe("packages/cli/script/postinstall.mjs")
  expect(spans[1]!.added).toBe(4)
  expect(spans[1]!.removed).toBe(1)
  expect(spans[2]!.target).toBe("npm pack --dry-run")
  expect(spans[2]!.messageID).toBe("msg_a")
})

test("reasoning is a think span and assistant text is a write span", () => {
  const spans = agentSpans([
    assistant({
      id: "msg_b",
      created: 50,
      streamed: 60,
      completed: 900,
      content: [think("the fallback resolves the wrong tarball", 100, 400), write("Now the Windows fallback.")],
    }),
  ])
  expect(spans.map((span) => [span.kind, span.t0, span.t1])).toEqual([
    ["write", 60, 900],
    ["think", 100, 400],
  ])
  expect(spans[0]!.target).toBe("Now the Windows fallback.")
})

test("a failed tool keeps its error, and a retry is its own span", () => {
  const spans = agentSpans([
    assistant({
      id: "msg_c",
      created: 0,
      retry: { attempt: 2, at: 500, message: "429 from provider" },
      content: [
        tool({
          id: "t1",
          name: "webfetch",
          created: 600,
          ran: 700,
          completed: 800,
          state: "error",
          input: { url: "https://registry.example" },
          error: "registry refused",
        }),
      ],
    }),
  ])
  expect(spans[0]).toMatchObject({ kind: "retry", t0: 500, name: "retry", error: "429 from provider" })
  expect(spans[1]).toMatchObject({
    kind: "tool",
    letter: "W",
    t0: 700,
    t1: 800,
    error: "registry refused",
  })
})

test("a waiting row appends an ask span and stateAt reports it", () => {
  const spec: UnderstorySpec = { id: "ses_wait", agent: "coder", state: "waiting", pending: 1, tools: [] }
  const waiting = row(spec)
  expect(waiting.state).toBe("waiting")

  const fixture = understoryFixture({ specs: [spec] })
  const messages = fixture.messages["ses_wait"] ?? []
  const spans = agentSpans(messages, { state: waiting.state, ask: "npm pack --dry-run", start: waiting.startedAt })
  const ask = spans.at(-1)!
  expect(ask.kind).toBe("ask")
  expect(ask.target).toBe("npm pack --dry-run")
  expect(ask.t1).toBeUndefined()
  expect(stateAt(waiting, spans, ask.t0 + 1)).toBe("waiting")
  expect(nowText(waiting, spans, ask.t0 + 1)).toBe("needs you: npm pack --dry-run")
  expect(stateAt(waiting, spans, 0)).toBe("idle")
})

test("a finished row keeps its terminal state and shows its return", () => {
  const spec: UnderstorySpec = {
    id: "ses_done",
    agent: "explore",
    state: "done",
    summary: "two candidates share a package name",
    created: 1_000,
  }
  const done = row(spec)
  const fixture = understoryFixture({ specs: [spec] })
  const spans = agentSpans(fixture.messages["ses_done"] ?? [])

  expect(stateAt(done, spans, done.endedAt! + 1)).toBe("done")
  expect(nowText(done, spans, done.endedAt! + 1)).toBe("two candidates share a package name")

  const killed = row({ id: "ses_killed", agent: "scout", state: "killed", killed: true })
  expect(stateAt(killed, [], killed.endedAt! + 1)).toBe("killed")
  expect(nowText(killed, [], killed.endedAt! + 1)).toBe("killed")
})

test("nowText names the running call and its elapsed time", () => {
  const spec: UnderstorySpec = {
    id: "ses_now",
    agent: "coder",
    state: "running",
    created: 0,
  }
  const running = row(spec)
  const spans: readonly AgentSpan[] = [
    {
      id: "a",
      kind: "tool",
      t0: 0,
      t1: 1_200,
      letter: "E",
      name: "edit",
      target: "postinstall.mjs",
    },
    {
      id: "b",
      kind: "tool",
      t0: 2_000,
      letter: "$",
      name: "shell",
      target: "npm pack --dry-run",
    },
  ]
  expect(nowText(running, spans, 600)).toBe("edit postinstall.mjs 1.2s")
  expect(nowText(running, spans, 1_500)).toBe("")
  expect(nowText(running, spans, 3_500)).toBe("shell npm pack --dry-run 1.5s")
  expect(durationText(1_234)).toBe("1.2s")
  expect(spanAt(spans, 1_300)).toBeUndefined()
  expect(spanAt(spans, 2_500)!.id).toBe("b")
})

test("tokenBuckets spread a message's real tokens with no wobble", () => {
  const messages = [
    assistant({ id: "msg_t", created: 0, completed: 10_000, tokens: tokens(90, 10), content: [] }),
  ]
  const buckets = tokenBuckets(agentSpans(messages), messages, 0, 10_000, 10)
  expect(buckets).toHaveLength(10)
  expect(buckets.every((bucket) => bucket.tokens === 10)).toBe(true)
  expect(buckets.every((bucket) => bucket.rate === 10)).toBe(true)
  expect(buckets.reduce((total, bucket) => total + bucket.tokens, 0)).toBe(100)

  // Outside the streaming interval there is no signal, so the bar is flat.
  const outside = tokenBuckets(agentSpans(messages), messages, 20_000, 30_000, 10)
  expect(outside.every((bucket) => bucket.tokens === 0 && bucket.rate === 0)).toBe(true)

  // A message with no token record contributes nothing rather than a guess.
  const quiet = [assistant({ id: "msg_q", created: 0, completed: 10_000, content: [] })]
  expect(tokenBuckets(agentSpans(quiet), quiet, 0, 10_000, 4).every((bucket) => bucket.tokens === 0)).toBe(true)
})

test("a row at T carries the tokens and the tools that had really happened", () => {
  const messages = [
    assistant({ id: "msg_a", created: 0, completed: 1_000, tokens: tokens(400, 100), content: [] }),
    assistant({
      id: "msg_b",
      created: 2_000,
      completed: 3_000,
      tokens: tokens(900, 100),
      content: [tool({ id: "tb", name: "read", created: 2_100, ran: 2_100, completed: 2_200 })],
    }),
    assistant({
      id: "msg_c",
      created: 4_000,
      completed: 5_000,
      tokens: tokens(20, 5),
      content: [tool({ id: "tc", name: "bash", created: 4_100, ran: 4_100, completed: 4_300 })],
    }),
  ]
  const spans = agentSpans(messages)
  const row: RosterRow = {
    sessionID: "ses_a",
    depth: 1,
    agent: "coder",
    label: "coder-1",
    state: "done",
    pending: 0,
    tokens: 4_525,
    cost: 0,
    startedAt: 0,
    endedAt: 5_000,
    historyMayBeTruncated: false,
    hasChildren: false,
  }

  // Before anything finished: no tokens, no calls, still running.
  const early = rowAt(row, spans, messages, 500)
  expect(early.tokens).toBe(0)
  expect(early.endedAt).toBeUndefined()
  expect(toolCountAt(spans, 500)).toBe(0)

  // The first message completed (1_000 + 400 + 100) and the second is mid-call.
  const middle = rowAt(row, spans, messages, 2_500)
  expect(middle.tokens).toBe(1_500)
  expect(middle.state).toBe("running")
  expect(middle.endedAt).toBeUndefined()
  expect(toolCountAt(spans, 2_500)).toBe(1)

  // Everything completed by the end: the row's own total, both calls, ended.
  const end = rowAt(row, spans, messages, 5_000)
  expect(end.tokens).toBe(4_525)
  expect(end.state).toBe("done")
  expect(end.endedAt).toBe(5_000)
  expect(toolCountAt(spans, 5_000)).toBe(2)

  // A row without any per-message usage keeps the session's own total: there
  // is no signal to spread, and the roster must not read zero.
  const quiet = [assistant({ id: "msg_q", created: 0, completed: 1_000, content: [] })]
  expect(rowAt(row, agentSpans(quiet), quiet, 1_000).tokens).toBe(4_525)
})

test("stage spans are bounded per session", () => {
  const content = Array.from({ length: 40 }, (_, index) =>
    tool({ id: `t${index}`, name: "read", created: index * 10, ran: index * 10, completed: index * 10 + 5 }),
  )
  const spans = agentSpans([assistant({ id: "msg_cap", created: 0, completed: 500, content })], { limit: 10 })
  expect(spans).toHaveLength(10)
  expect(spans[0]!.t0).toBe(300)
  expect(SPAN_CAP_PER_SESSION).toBeGreaterThan(10)
})

test("staleEdits reports B editing a file A edited after B's read, and clears on re-read", () => {
  const sessions = [
    {
      sessionID: "A",
      label: "coder-1",
      messages: [
        assistant({
          id: "a1",
          created: 0,
          completed: 400,
          content: [
            tool({ id: "a-read", name: "read", created: 90, ran: 100, completed: 120, input: { filePath: "f.ts" } }),
            tool({
              id: "a-edit",
              name: "edit",
              created: 290,
              ran: 300,
              completed: 320,
              input: { filePath: "f.ts" },
            }),
          ],
        }),
      ],
    },
    {
      sessionID: "B",
      label: "coder-2",
      messages: [
        assistant({
          id: "b1",
          created: 0,
          completed: 500,
          content: [
            tool({ id: "b-read", name: "read", created: 190, ran: 200, completed: 220, input: { filePath: "f.ts" } }),
            tool({
              id: "b-edit",
              name: "edit",
              created: 390,
              ran: 400,
              completed: 420,
              input: { filePath: "f.ts" },
            }),
          ],
        }),
      ],
    },
  ] as const

  const found = staleEdits(sessions)
  expect(found).toHaveLength(1)
  expect(found[0]).toMatchObject({
    path: "f.ts",
    reader: "B",
    readerLabel: "coder-2",
    writer: "A",
    writerLabel: "coder-1",
    readAt: 200,
    editedAt: 400,
  })

  // B re-reads the file: the warning clears.
  const reread = [
    sessions[0],
    {
      ...sessions[1],
      messages: [
        ...sessions[1].messages,
        assistant({
          id: "b2",
          created: 500,
          completed: 600,
          content: [
            tool({ id: "b-reread", name: "read", created: 590, ran: 600, completed: 620, input: { filePath: "f.ts" } }),
          ],
        }),
      ],
    },
  ]
  expect(staleEdits(reread)).toEqual([])
})

test("a blind edit with no read is not called a stale read", () => {
  const sessions = [
    {
      sessionID: "A",
      label: "coder-1",
      messages: [
        assistant({
          id: "a1",
          created: 0,
          completed: 200,
          content: [
            tool({ id: "a-edit", name: "edit", created: 90, ran: 100, completed: 120, input: { filePath: "g.ts" } }),
          ],
        }),
      ],
    },
    {
      sessionID: "B",
      label: "coder-2",
      messages: [
        assistant({
          id: "b1",
          created: 0,
          completed: 400,
          content: [
            tool({ id: "b-edit", name: "edit", created: 290, ran: 300, completed: 320, input: { filePath: "g.ts" } }),
          ],
        }),
      ],
    },
  ] as const
  expect(staleEdits(sessions)).toEqual([])
})

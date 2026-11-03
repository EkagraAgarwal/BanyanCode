import { expect, test } from "bun:test"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { meshNode, session } from "./harness"
import { runStateLabel } from "../src/components/understory/layout"
import {
  agentSheet,
  canonicalTool,
  HOST_MESSAGE_CAP,
  isLiveState,
  mayBeTruncated,
  nextAttention,
  rosterRows,
  runSheet,
  shortLabel,
  stateGlyph,
  streamEntries,
  toolKind,
  visibleRows,
  type RosterRow,
  type StreamSession,
  type UnderstoryState,
} from "../src/data/understory"

const tokens = (total: number) => ({ input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

function child(input: {
  id: string
  agent: string
  created: number
  parent?: string
  title?: string
  cost?: number
  tokens?: number
  idle?: number
  updated?: number
  outcome?: "succeeded" | "failed" | "interrupted"
}): SessionInfo {
  return session({
    id: input.id,
    parentID: input.parent ?? "ses_root",
    agent: input.agent,
    title: input.title ?? `${input.agent} task`,
    cost: input.cost ?? 0,
    tokens: tokens(input.tokens ?? 0),
    model: { providerID: "provider", id: "deepseek-v4.1-flash" },
    time: {
      created: input.created,
      updated: input.updated ?? 2_000,
      ...(input.idle === undefined ? {} : { idle: input.idle }),
    },
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
  })
}

function root(input: { idle?: number; outcome?: "succeeded" | "failed" | "interrupted" } = {}): SessionInfo {
  return session({
    id: "ses_root",
    agent: "build",
    title: "orchestrate the installer fix",
    time: { created: 900, updated: 2_000, ...(input.idle === undefined ? {} : { idle: input.idle }) },
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
  })
}

function userMessage(id: string, created: number, text = "do the thing"): SessionMessageInfo {
  return { id, type: "user", time: { created }, text } as unknown as SessionMessageInfo
}

function assistantMessage(input: {
  id: string
  created: number
  completed?: number
  content?: readonly unknown[]
  model?: string
  agent?: string
}): SessionMessageInfo {
  return {
    id: input.id,
    type: "assistant",
    time: {
      created: input.created,
      ...(input.completed === undefined ? {} : { completed: input.completed }),
    },
    agent: input.agent ?? "coder",
    model: { providerID: "provider", id: input.model ?? "deepseek-v4.1-flash" },
    content: input.content ?? [],
  } as unknown as SessionMessageInfo
}

function toolPart(input: {
  id: string
  name: string
  created: number
  ran?: number
  completed?: number
  input?: unknown
  status?: "streaming" | "running" | "completed" | "error"
  metadata?: Record<string, unknown>
  error?: string
}): unknown {
  const status = input.status ?? (input.completed === undefined ? "running" : "completed")
  const state =
    status === "streaming"
      ? { status, input: input.input ?? "" }
      : status === "running"
        ? { status, input: input.input ?? {}, metadata: input.metadata ?? {} }
        : status === "completed"
          ? {
              status,
              input: input.input ?? {},
              content: [{ type: "text", text: "" }],
              ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            }
          : {
              status,
              input: input.input ?? {},
              error: { type: "test", message: input.error ?? "failed" },
              ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            }
  return {
    type: "tool",
    id: input.id,
    name: input.name,
    state,
    time: {
      created: input.created,
      ...(input.ran === undefined ? {} : { ran: input.ran }),
      ...(input.completed === undefined ? {} : { completed: input.completed }),
    },
  }
}

const textPart = (text: string) => ({ type: "text", text })
const thinkPart = (text: string) => ({ type: "reasoning", text })

const statesOf = (rows: readonly RosterRow[]) => rows.map((row) => row.state)
const idsOf = (rows: readonly RosterRow[]) => rows.map((row) => row.sessionID)
const labelsOf = (rows: readonly RosterRow[]) => rows.map((row) => row.label)

test("suffix numbering follows spawn order and never reorders when state changes", () => {
  const sessions = [
    root(),
    child({ id: "ses_a", agent: "coder", created: 200, idle: 1_500 }),
    child({ id: "ses_b", agent: "coder", created: 100 }),
    child({ id: "ses_c", agent: "explore", created: 50 }),
  ]

  const idle = rosterRows({ root: "ses_root", sessions })
  expect(idsOf(idle)).toEqual(["ses_root", "ses_c", "ses_b", "ses_a"])
  expect(labelsOf(idle)).toEqual(["build", "explore", "coder-1", "coder-2"])
  expect(statesOf(idle)).toEqual(["idle", "idle", "idle", "done"])

  // The same tree with different live state keeps the same order and labels.
  const mesh = meshNode({
    sessionID: "ses_root",
    state: "running",
    children: [
      meshNode({ sessionID: "ses_c", agent: "explore", state: "running" }),
      meshNode({ sessionID: "ses_b", agent: "coder", state: "failed" }),
      meshNode({ sessionID: "ses_a", agent: "coder", state: "retry" }),
    ],
  })
  const live = rosterRows({ root: "ses_root", sessions, mesh })
  expect(idsOf(live)).toEqual(idsOf(idle))
  expect(labelsOf(live)).toEqual(labelsOf(idle))
  expect(statesOf(live)).toEqual(["running", "running", "failed", "retry"])

  // A lone agent keeps its plain name.
  const singleton = rosterRows({
    root: "ses_root",
    sessions: [root(), child({ id: "ses_only", agent: "scout", created: 100 })],
  })
  expect(labelsOf(singleton)).toEqual(["build", "scout"])
})

test("a killed child keeps its position and its descendants stay on the roster", () => {
  const sessions = [
    root(),
    child({ id: "ses_a", agent: "coder", created: 100 }),
    child({ id: "ses_scout", agent: "scout", created: 110, parent: "ses_a" }),
    child({ id: "ses_b", agent: "coder", created: 200 }),
  ]
  // mesh.status has already dropped the killed subtree; only the ID list keeps it.
  const mesh = meshNode({
    sessionID: "ses_root",
    state: "running",
    children: [meshNode({ sessionID: "ses_b", agent: "coder", state: "running" })],
  })
  const rows = rosterRows({ root: "ses_root", sessions, mesh, killed: new Set(["ses_a"]) })
  expect(idsOf(rows)).toEqual(["ses_root", "ses_a", "ses_scout", "ses_b"])
  expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 1])
  expect(rows[1]!.state).toBe("killed")
  expect(rows[1]!.endedAt).toBe(2_000)
  expect(labelsOf(rows)).toEqual(["build", "coder-1", "scout", "coder-2"])
})

test("interrupted is failed, not killed; only the killed list is killed", () => {
  const sessions = [root(), child({ id: "ses_a", agent: "coder", created: 100 })]
  const interrupted = rosterRows({
    root: "ses_root",
    sessions,
    mesh: meshNode({
      sessionID: "ses_root",
      state: "running",
      children: [meshNode({ sessionID: "ses_a", agent: "coder", state: "interrupted" })],
    }),
  })
  expect(interrupted[1]!.state).toBe("failed")

  // A session-level outcome survives even when the mesh node is gone.
  const outcome = rosterRows({
    root: "ses_root",
    sessions: [root(), child({ id: "ses_a", agent: "coder", created: 100, outcome: "interrupted" })],
  })
  expect(outcome[1]!.state).toBe("failed")
  expect(outcome[1]!.state).not.toBe("killed")
})

test("pending permissions make a running agent wait, but never override failure or a kill", () => {
  const sessions = [
    root(),
    child({ id: "ses_run", agent: "coder", created: 100 }),
    child({ id: "ses_fail", agent: "coder", created: 200 }),
    child({ id: "ses_kill", agent: "coder", created: 300 }),
  ]
  const mesh = meshNode({
    sessionID: "ses_root",
    state: "running",
    children: [
      meshNode({ sessionID: "ses_run", agent: "coder", state: "running" }),
      meshNode({ sessionID: "ses_fail", agent: "coder", state: "failed" }),
      meshNode({ sessionID: "ses_kill", agent: "coder", state: "idle" }),
    ],
  })
  const rows = rosterRows({
    root: "ses_root",
    sessions,
    mesh,
    killed: new Set(["ses_kill"]),
    pending: (id) => (id === "ses_root" ? 0 : 1),
  })
  expect(statesOf(rows)).toEqual(["running", "waiting", "failed", "killed"])
})

test("failed and killed never read as done, even once the session has gone idle", () => {
  const sessions = [
    root({ idle: 1_800 }),
    child({ id: "ses_fail", agent: "coder", created: 100, idle: 1_700 }),
    child({ id: "ses_kill", agent: "coder", created: 200, idle: 1_700 }),
    child({ id: "ses_ok", agent: "coder", created: 300, idle: 1_700 }),
  ]
  const mesh = meshNode({
    sessionID: "ses_root",
    state: "idle",
    children: [
      meshNode({ sessionID: "ses_fail", agent: "coder", state: "failed" }),
      meshNode({ sessionID: "ses_kill", agent: "coder", state: "idle" }),
      meshNode({ sessionID: "ses_ok", agent: "coder", state: "idle" }),
    ],
  })
  const rows = rosterRows({ root: "ses_root", sessions, mesh, killed: new Set(["ses_kill"]) })
  expect(rows[1]!.state).toBe("failed")
  expect(rows[2]!.state).toBe("killed")
  expect(rows[3]!.state).toBe("done")
  expect(rows.filter((row) => row.state === "done").map((row) => row.sessionID)).toEqual(["ses_ok"])
})

test("an idle root is idle, not done", () => {
  const rows = rosterRows({ root: "ses_root", sessions: [root({ idle: 1_800 })] })
  expect(rows).toHaveLength(1)
  expect(rows[0]!.state).toBe("idle")
  expect(stateGlyph(rows[0]!.state, "*")).toBe("○")
  // The last turn ended at 1800, so the run's final duration is known even
  // though the root itself is idle and ready for the next prompt.
  expect(rows[0]!.endedAt).toBe(1_800)
})

test("a done child has an end time; glyphs stay distinct", () => {
  const rows = rosterRows({
    root: "ses_root",
    sessions: [root(), child({ id: "ses_a", agent: "coder", created: 100, idle: 1_700 })],
  })
  expect(rows[1]!.state).toBe("done")
  expect(rows[1]!.endedAt).toBe(1_700)
  const glyphs = new Set(
    (["idle", "retry", "waiting", "blocked", "done", "failed", "killed"] as UnderstoryState[]).map((state) =>
      stateGlyph(state, "*"),
    ),
  )
  expect(glyphs.size).toBe(7)
  expect(stateGlyph("running", "⠋")).toBe("⠋")
})

test("blocked needs an open subagent call and live descendants", () => {
  const blocked = rosterRows({
    root: "ses_root",
    sessions: [root(), child({ id: "ses_mid", agent: "coder", created: 100 }), child({ id: "ses_leaf", agent: "scout", created: 110, parent: "ses_mid" })],
    mesh: meshNode({
      sessionID: "ses_root",
      state: "running",
      children: [
        meshNode({
          sessionID: "ses_mid",
          agent: "coder",
          state: "running",
          children: [meshNode({ sessionID: "ses_leaf", agent: "scout", state: "running" })],
        }),
      ],
    }),
    messages: (id) =>
      id === "ses_mid"
        ? [
            assistantMessage({
              id: "m_blk",
              created: 1_000,
              content: [toolPart({ id: "t_blk", name: "subagent", created: 1_000, input: { agent: "scout", description: "scan" } })],
            }),
          ]
        : [],
  })
  expect(statesOf(blocked)).toEqual(["running", "blocked", "running"])
  expect(isLiveState("blocked")).toBe(true)

  // Same open call, but every descendant has finished: it is just running.
  const drained = rosterRows({
    root: "ses_root",
    sessions: [root(), child({ id: "ses_mid", agent: "coder", created: 100 }), child({ id: "ses_leaf", agent: "scout", created: 110, parent: "ses_mid", idle: 1_500 })],
    mesh: meshNode({
      sessionID: "ses_root",
      state: "running",
      children: [meshNode({ sessionID: "ses_mid", agent: "coder", state: "running" })],
    }),
    messages: (id) =>
      id === "ses_mid"
        ? [
            assistantMessage({
              id: "m_blk",
              created: 1_000,
              content: [toolPart({ id: "t_blk", name: "subagent", created: 1_000, input: { agent: "scout" } })],
            }),
          ]
        : [],
  })
  expect(drained[1]!.state).toBe("running")
  expect(drained[2]!.state).toBe("done")
})

test("unknown tools get ?, and every known tool gets its letter", () => {
  expect(toolKind("read")).toBe("R")
  expect(toolKind("read_file")).toBe("R")
  expect(toolKind("grep")).toBe("S")
  expect(toolKind("glob")).toBe("S")
  expect(toolKind("list")).toBe("S")
  expect(toolKind("edit")).toBe("E")
  expect(toolKind("write")).toBe("E")
  expect(toolKind("patch")).toBe("E")
  expect(toolKind("apply_patch")).toBe("E")
  expect(toolKind("safe_rename")).toBe("E")
  expect(toolKind("bash")).toBe("$")
  expect(toolKind("shell")).toBe("$")
  expect(toolKind("banyan_test")).toBe("V")
  expect(toolKind("webfetch")).toBe("W")
  expect(toolKind("websearch")).toBe("W")
  expect(toolKind("subagent")).toBe("T")
  expect(toolKind("task")).toBe("T")
  expect(toolKind("repository_query")).toBe("S")
  expect(toolKind("codegraph_callers")).toBe("S")
  expect(toolKind("todowrite")).toBe("?")
  expect(toolKind("skill")).toBe("?")
  expect(toolKind("something-new")).toBe("?")
  expect(canonicalTool("bash")).toBe("shell")
})

test("a streaming tool call with a raw JSON string input stays readable", () => {
  const sessions: StreamSession[] = [
    {
      sessionID: "ses_a",
      label: "coder-1",
      state: "running",
      messages: [
        userMessage("m_user", 1_000),
        assistantMessage({
          id: "m_a",
          created: 1_010,
          content: [
            toolPart({
              id: "t_stream",
              name: "read",
              created: 1_020,
              input: '{"filePath":"src/main.t',
              status: "streaming",
            }),
          ],
        }),
      ],
    },
  ]
  const entries = streamEntries(sessions, { now: 1_500 })
  const tool = entries.find((entry) => entry.kind === "tool")!
  expect(tool.detail?.letter).toBe("R")
  expect(tool.detail?.target).toBe('{"filePath":"src/main.t')
  expect(tool.detail?.open).toBe(true)
  expect(tool.detail?.durationMs).toBe(480)
  expect(tool.summary).toBe('read {"filePath":"src/main.t')
})

test("stream entries are time-ordered with deterministic ties and filter by agent", () => {
  const first: StreamSession = {
    sessionID: "ses_a",
    label: "coder-1",
    state: "running",
    messages: [
      userMessage("a_user", 1_000),
      assistantMessage({
        id: "a_assistant",
        created: 1_000,
        content: [
          thinkPart("look at the files"),
          textPart("reading now"),
          toolPart({
            id: "a_tool",
            name: "edit",
            created: 1_000,
            ran: 1_010,
            completed: 1_050,
            input: { filePath: "src/a.ts" },
            metadata: { files: [{ file: "src/a.ts", additions: 3, deletions: 1 }] },
          }),
        ],
      }),
    ],
  }
  const second: StreamSession = {
    sessionID: "ses_b",
    label: "coder-2",
    state: "killed",
    endedAt: 1_100,
    messages: [userMessage("b_user", 1_000), assistantMessage({ id: "b_assistant", created: 1_000, content: [textPart("done here")] })],
  }

  const entries = streamEntries([first, second])
  expect(entries.map((entry) => `${entry.sessionID}:${entry.kind}:${entry.at}`)).toEqual([
    "ses_a:user:1000",
    "ses_a:think:1000",
    "ses_a:text:1000",
    "ses_b:user:1000",
    "ses_b:text:1000",
    "ses_a:tool:1010",
    "ses_b:kill:1100",
  ])
  const tool = entries.find((entry) => entry.kind === "tool")!
  expect(tool.detail).toMatchObject({ tool: "edit", letter: "E", target: "src/a.ts", added: 3, removed: 1, error: false })
  expect(tool.detail?.durationMs).toBe(40)
  expect(entries.at(-1)).toMatchObject({ kind: "kill", approximate: true })

  const onlySecond = streamEntries([first, second], { agent: "coder-2" })
  expect(onlySecond.every((entry) => entry.sessionID === "ses_b")).toBe(true)
  expect(streamEntries([first, second], { agent: "ses_b" })).toHaveLength(3)
})

test("spawn and return come from the parent's subagent call", () => {
  const sessions: StreamSession[] = [
    {
      sessionID: "ses_root",
      label: "build",
      state: "running",
      messages: [
        assistantMessage({
          id: "m_spawn",
          created: 1_000,
          content: [
            toolPart({
              id: "t_spawn",
              name: "subagent",
              created: 1_000,
              ran: 1_010,
              completed: 1_200,
              input: { agent: "coder", description: "fix the installer" },
              metadata: { sessionID: "ses_a", status: "completed" },
            }),
          ],
        }),
      ],
    },
    {
      sessionID: "ses_a",
      label: "coder-1",
      state: "done",
      endedAt: 1_190,
      returned: "installer fixed",
      messages: [],
    },
  ]
  const entries = streamEntries(sessions).filter((entry) => entry.sessionID === "ses_root")
  expect(entries.map((entry) => entry.kind)).toEqual(["spawn", "return"])
  expect(entries[0]!.summary).toBe("spawned coder-1: fix the installer")
  expect(entries[0]!.detail?.letter).toBe("T")
  expect(entries[1]!.summary).toBe("installer fixed")
  expect(entries[1]!.at).toBe(1_200)
})

test("a failed subagent call is a fail row, not a return", () => {
  const sessions: StreamSession[] = [
    {
      sessionID: "ses_root",
      label: "build",
      state: "running",
      messages: [
        assistantMessage({
          id: "m_spawn",
          created: 1_000,
          content: [
            toolPart({
              id: "t_spawn",
              name: "subagent",
              created: 1_000,
              ran: 1_010,
              completed: 1_100,
              status: "error",
              error: "child exited",
              input: { agent: "coder" },
            }),
          ],
        }),
      ],
    },
  ]
  const kinds = streamEntries(sessions).filter((entry) => entry.sessionID === "ses_root").map((entry) => entry.kind)
  expect(kinds).toEqual(["spawn", "fail"])
})

test("the stream keeps the newest 500 entries per session", () => {
  const content = Array.from({ length: 620 }, (_, index) =>
    toolPart({ id: `t${index}`, name: "read", created: 1_000 + index, completed: 1_000 + index, input: { filePath: `f${index}.ts` } }),
  )
  const entries = streamEntries([
    {
      sessionID: "ses_a",
      label: "coder-1",
      state: "running",
      messages: [assistantMessage({ id: "m_a", created: 1_000, content })],
    },
  ])
  expect(entries).toHaveLength(500)
  expect(entries[0]!.detail?.target).toBe("f120.ts")
  expect(entries.at(-1)!.detail?.target).toBe("f619.ts")
})

test("shortLabel keeps numbers and stays distinct at every roster width", () => {
  const labels = Array.from({ length: 20 }, (_, index) => `coder-${index + 1}`)
  for (let width = 6; width <= 14; width++) {
    const shortened = labels.map((label) => shortLabel(label, width))
    expect(new Set(shortened).size).toBe(20)
    for (const [index, value] of shortened.entries()) {
      expect(value.length).toBeLessThanOrEqual(width)
      expect(value.endsWith(`-${index + 1}`)).toBe(true)
    }
  }
  expect(shortLabel("explore", 14)).toBe("explore")
  expect(shortLabel("explore-1", 6)).toBe("exp…-1")
  expect(shortLabel("coder-20", 6)).toBe("co…-20")
  expect(shortLabel("anything", 0)).toBe("")
})

test("nextAttention cycles waiting then failed and continues past an agent that stopped waiting", () => {
  const rows: RosterRow[] = [
    { sessionID: "root", depth: 0, agent: "build", label: "build", state: "running", pending: 0, tokens: 0, cost: 0, startedAt: 0, historyMayBeTruncated: false, hasChildren: true },
    { sessionID: "a", depth: 1, parentID: "root", agent: "coder", label: "coder-1", state: "waiting", pending: 1, tokens: 0, cost: 0, startedAt: 0, historyMayBeTruncated: false, hasChildren: false },
    { sessionID: "b", depth: 1, parentID: "root", agent: "coder", label: "coder-2", state: "running", pending: 0, tokens: 0, cost: 0, startedAt: 0, historyMayBeTruncated: false, hasChildren: false },
    { sessionID: "c", depth: 1, parentID: "root", agent: "scout", label: "scout", state: "waiting", pending: 2, tokens: 0, cost: 0, startedAt: 0, historyMayBeTruncated: false, hasChildren: false },
    { sessionID: "d", depth: 1, parentID: "root", agent: "reviewer", label: "reviewer", state: "failed", pending: 0, tokens: 0, cost: 0, startedAt: 0, historyMayBeTruncated: false, hasChildren: false },
  ]

  expect(nextAttention(rows, undefined)).toBe("a")
  expect(nextAttention(rows, "a")).toBe("c")
  expect(nextAttention(rows, "c")).toBe("d")
  expect(nextAttention(rows, "d")).toBe("a")

  // `a` stops waiting: the next press still continues after its tree position.
  const settled = rows.map((row) => (row.sessionID === "a" ? { ...row, state: "running" as const, pending: 0 } : row))
  expect(nextAttention(settled, "a")).toBe("c")
  expect(nextAttention(settled, "c")).toBe("d")
  expect(nextAttention(settled, "d")).toBe("c")
  expect(nextAttention(rows.map((row) => ({ ...row, state: "running" as const })), "a")).toBeUndefined()
})

test("folding hides done rows, keeps failures and kills, and moves the selection", () => {
  const sessions = [
    root(),
    child({ id: "ses_a", agent: "coder", created: 100, idle: 1_700 }),
    child({ id: "ses_b", agent: "coder", created: 200, idle: 1_700 }),
    child({ id: "ses_c", agent: "scout", created: 300 }),
    child({ id: "ses_d", agent: "reviewer", created: 400 }),
    child({ id: "ses_e", agent: "coder", created: 500 }),
  ]
  const mesh = meshNode({
    sessionID: "ses_root",
    state: "running",
    children: [
      meshNode({ sessionID: "ses_a", agent: "coder", state: "idle" }),
      meshNode({ sessionID: "ses_b", agent: "coder", state: "idle" }),
      meshNode({ sessionID: "ses_c", agent: "scout", state: "failed" }),
      meshNode({ sessionID: "ses_d", agent: "reviewer", state: "idle" }),
      meshNode({ sessionID: "ses_e", agent: "coder", state: "running" }),
    ],
  })
  const rows = rosterRows({ root: "ses_root", sessions, mesh, killed: new Set(["ses_d"]) })

  const unfolded = visibleRows(rows, { folded: false })
  expect(unfolded.rows).toHaveLength(6)
  expect(unfolded.hidden).toBe(0)

  const folded = visibleRows(rows, { folded: true, selected: "ses_b" })
  expect(idsOf(folded.rows)).toEqual(["ses_root", "ses_c", "ses_d", "ses_e"])
  expect(folded.hidden).toBe(2)
  expect(folded.replaced).toBe(true)
  expect(folded.selected).toBe("ses_c")

  // A selection that survives folding is left alone.
  const kept = visibleRows(rows, { folded: true, selected: "ses_e" })
  expect(kept.replaced).toBe(false)
  expect(kept.selected).toBe("ses_e")
})

test("a done parent stays visible while one of its descendants is still live", () => {
  const sessions = [
    root(),
    child({ id: "ses_mid", agent: "coder", created: 100, idle: 1_700 }),
    child({ id: "ses_leaf", agent: "scout", created: 110, parent: "ses_mid" }),
  ]
  const mesh = meshNode({
    sessionID: "ses_root",
    state: "running",
    children: [
      meshNode({
        sessionID: "ses_mid",
        agent: "coder",
        state: "idle",
        children: [meshNode({ sessionID: "ses_leaf", agent: "scout", state: "running" })],
      }),
    ],
  })
  const rows = rosterRows({ root: "ses_root", sessions, mesh })
  expect(rows[1]!.state).toBe("done")
  expect(rows[2]!.state).toBe("running")
  const folded = visibleRows(rows, { folded: true })
  expect(idsOf(folded.rows)).toEqual(["ses_root", "ses_mid", "ses_leaf"])
  expect(folded.hidden).toBe(0)
})

test("history truncation is exposed per session, never for the root", () => {
  const many = Array.from({ length: HOST_MESSAGE_CAP }, (_, index) => userMessage(`u${index}`, index + 1))
  expect(mayBeTruncated(many)).toBe(true)
  expect(mayBeTruncated(many, { root: true })).toBe(false)
  expect(mayBeTruncated([assistantMessage({ id: "m", created: 1 })])).toBe(true)
  expect(mayBeTruncated([userMessage("u", 1)])).toBe(false)

  const rows = rosterRows({
    root: "ses_root",
    sessions: [root(), child({ id: "ses_a", agent: "coder", created: 100 })],
    messages: (id) => (id === "ses_a" ? many : []),
  })
  expect(rows[1]!.historyMayBeTruncated).toBe(true)
  expect(rows[0]!.historyMayBeTruncated).toBe(false)
})

test("runSheet shows branch tokens and returned summaries; agentSheet hides zero cost", () => {
  const sessions = [
    root(),
    child({ id: "ses_a", agent: "coder", created: 100, tokens: 1_200, cost: 0.25, idle: 1_700 }),
    child({ id: "ses_b", agent: "scout", created: 200 }),
  ]
  const messages: Record<string, SessionMessageInfo[]> = {
    ses_a: [
      userMessage("a_user", 1_000),
      assistantMessage({
        id: "a_assistant",
        created: 1_010,
        completed: 1_700,
        content: [
          textPart("installer fixed"),
          toolPart({
            id: "a_edit",
            name: "edit",
            created: 1_020,
            completed: 1_030,
            input: { filePath: "src/install.ts" },
            metadata: { files: [{ file: "src/install.ts", additions: 2, deletions: 1 }] },
          }),
          toolPart({ id: "a_read", name: "read", created: 1_040, completed: 1_045, input: { filePath: "src/main.ts" } }),
        ],
      }),
    ],
    ses_b: [],
  }
  const rows = rosterRows({
    root: "ses_root",
    sessions,
    mesh: meshNode({
      sessionID: "ses_root",
      state: "running",
      children: [
        meshNode({ sessionID: "ses_a", agent: "coder", state: "idle" }),
        meshNode({ sessionID: "ses_b", agent: "scout", state: "running" }),
      ],
    }),
    messages: (id) => messages[id] ?? [],
  })

  const run = runSheet({ rows, root: "ses_root", selected: "ses_root", messages: (id) => messages[id] ?? [] })
  expect(run?.branches.map((branch) => branch.label)).toEqual(["coder", "scout"])
  expect(run?.branches[0]!.tokens).toBe(1_200)
  expect(run?.branches[0]!.cost).toBe(0.25)
  expect(run?.branches[0]!.returned).toBe("installer fixed")
  expect(run?.branches[1]!.cost).toBeUndefined()
  expect(runSheet({ rows, root: "ses_root", selected: "ses_a", messages: () => [] })).toBeUndefined()

  const sheet = agentSheet({ rows, root: "ses_root", selected: "ses_a", messages: (id) => messages[id] ?? [] })!
  expect(sheet.state).toBe("done")
  expect(sheet.model).toBe("deepseek-v4.1-flash")
  expect(sheet.cost).toBe(0.25)
  expect(sheet.output.at(-1)).toBe("installer fixed")
  expect(sheet.tools.map((tool) => tool.name)).toEqual(["read", "edit"])
  expect(sheet.tools[0]!.letter).toBe("R")
  expect(sheet.files).toEqual([{ path: "src/install.ts", added: 2, removed: 1 }])

  const free = agentSheet({ rows, root: "ses_root", selected: "ses_b", messages: () => [] })!
  expect(free.cost).toBeUndefined()
  expect(agentSheet({ rows, root: "ses_root", messages: () => [] })).toBeUndefined()
})

test("runSheet only reports returns from finished branches", () => {
  const sessions = [
    root(),
    child({ id: "ses_done", agent: "coder", created: 100, idle: 1_500 }),
    child({ id: "ses_running", agent: "explore", created: 200 }),
    child({ id: "ses_failed", agent: "scout", created: 300, idle: 1_600, outcome: "failed" }),
  ]
  const messages: Record<string, SessionMessageInfo[]> = {
    ses_done: [assistantMessage({ id: "done_text", created: 1_000, completed: 1_100, content: [textPart("done words")] })],
    ses_running: [assistantMessage({ id: "run_text", created: 1_000, content: [textPart("still working")] })],
    ses_failed: [assistantMessage({ id: "fail_text", created: 1_000, completed: 1_100, content: [textPart("half done")] })],
  }
  const rows = rosterRows({
    root: "ses_root",
    sessions,
    mesh: meshNode({
      sessionID: "ses_root",
      state: "running",
      children: [
        meshNode({ sessionID: "ses_done", agent: "coder", state: "idle" }),
        meshNode({ sessionID: "ses_running", agent: "explore", state: "running" }),
        meshNode({ sessionID: "ses_failed", agent: "scout", state: "failed" }),
      ],
    }),
    messages: (id) => messages[id] ?? [],
  })
  const run = runSheet({ rows, root: "ses_root", selected: "ses_root", messages: (id) => messages[id] ?? [] })!
  const byLabel = new Map(run.branches.map((branch) => [branch.label, branch]))
  expect(byLabel.get("coder")?.returned).toBe("done words")
  expect(byLabel.get("explore")?.returned).toBeUndefined()
  expect(byLabel.get("scout")?.returned).toBeUndefined()
})

test("the root's run ends at its idle mark, and a newer busy turn reopens it", () => {
  const idleRoot = session({
    id: "ses_root",
    agent: "build",
    time: { created: 1_000, updated: 6_000, busy: 1_000, idle: 5_000 },
  })
  const ended = rosterRows({ root: "ses_root", sessions: [idleRoot] })
  expect(ended[0]!.endedAt).toBe(5_000)

  const busyRoot = session({
    id: "ses_root",
    agent: "build",
    time: { created: 1_000, updated: 7_000, busy: 6_000, idle: 5_000 },
  })
  const running = rosterRows({ root: "ses_root", sessions: [busyRoot] })
  expect(running[0]!.endedAt).toBeUndefined()
})

test("a root that keeps taking turns still starts its run at the session's creation", () => {
  // The projector rewrites `time.busy` on every execution, so a root that
  // spawns and then summarises would push the whole run to its last turn.
  const late = session({
    id: "ses_root",
    agent: "build",
    time: { created: 1_000, updated: 9_000, busy: 8_000, idle: 9_000 },
  })
  const rows = rosterRows({ root: "ses_root", sessions: [late, child({ id: "ses_coder", agent: "coder", created: 2_000, idle: 5_000 })] })
  expect(rows[0]!.startedAt).toBe(1_000)
  expect(rows[1]!.startedAt).toBe(2_000)
})

test("branches still running keep the run header on running after the root goes idle", () => {
  const sessions = [root({ idle: 5_000 }), child({ id: "ses_coder", agent: "coder", created: 2_000 })]
  // The root launched background branches and ended its own turn; one child is
  // still working, so the run is not finished.
  const rows = rosterRows({
    root: "ses_root",
    sessions,
    status: (sessionID) => (sessionID === "ses_coder" ? "running" : "idle"),
  })
  expect(rows[0]!.endedAt).toBe(5_000)
  expect(runStateLabel(rows)).toBe("running")

  const quiet = rosterRows({
    root: "ses_root",
    sessions: [root({ idle: 5_000 }), child({ id: "ses_coder", agent: "coder", created: 2_000, idle: 4_000 })],
  })
  expect(runStateLabel(quiet)).toBe("finished")
})

import { expect, test } from "bun:test"
import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import { childCurrentTool, subagentChildRows, subagentChildSessionIDs } from "../src/routes/session/subagent-rows"

function part(
  state: SessionMessageAssistantTool["state"],
  id = "call-subagent",
): SessionMessageAssistantTool {
  return {
    type: "tool",
    id,
    name: "subagent",
    state,
    time: state.status === "streaming" ? { created: 1 } : { created: 1, ran: 1 },
  }
}

function assistant(content: Extract<SessionMessageInfo, { type: "assistant" }>["content"]): SessionMessageInfo {
  return {
    type: "assistant",
    id: "msg_child",
    agent: "explore",
    model: { providerID: "fixture", id: "fixture" },
    time: { created: 1 },
    content,
  }
}

test("reads child session IDs from running metadata", () => {
  expect(subagentChildSessionIDs(part({ status: "running", input: {}, metadata: { sessionID: "ses_child" } }))).toEqual([
    "ses_child",
  ])
  expect(
    subagentChildSessionIDs(
      part({
        status: "running",
        input: {},
        metadata: {
          sessions: [{ sessionID: "ses_a" }, "ses_b"],
          children: ["ses_b", "ses_c"],
        },
      }),
    ),
  ).toEqual(["ses_a", "ses_b", "ses_c"])
  // Continuations name the session they continue.
  expect(subagentChildSessionIDs(part({ status: "running", input: { sessionID: "ses_cont" }, metadata: {} }))).toEqual([
    "ses_cont",
  ])
  // Streamed tool arguments are not a finished object yet.
  expect(subagentChildSessionIDs(part({ status: "streaming", input: '{"sessionID":"ses_x"' }))).toEqual([])
})

test("keeps only running children and drops the rest", () => {
  const children = [
    { sessionID: "ses_a", agent: "explore", status: "running", messages: [] },
    { sessionID: "ses_b", agent: "coder", status: "idle", messages: [] },
  ]
  expect(subagentChildRows(children)).toEqual([{ sessionID: "ses_a", agent: "explore", tool: undefined }])
  // A finished child disappears from the transcript rows.
  expect(subagentChildRows([{ ...children[0]!, status: "idle" }])).toEqual([])
})

test("reports the running tool of a child session", () => {
  const messages = [
    assistant([
      { type: "text", text: "Looking around" },
      {
        type: "tool",
        id: "call-1",
        name: "bash",
        state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "ok" }] },
        time: { created: 1, completed: 2 },
      },
      {
        type: "tool",
        id: "call-2",
        name: "read",
        state: { status: "running", input: { path: "packages/tui/src/app.tsx" }, metadata: {} },
        time: { created: 2, ran: 2 },
      },
    ]),
  ]
  expect(childCurrentTool(messages)).toEqual({
    name: "read",
    args: "packages/tui/src/app.tsx",
  })
  expect(childCurrentTool([])).toBeUndefined()
})

test("rows follow a fixture as it starts, updates, and finishes", () => {
  const running = (tool: string): SessionMessageInfo[] => [
    assistant([
      {
        type: "tool",
        id: `${tool}-1`,
        name: tool,
        state: { status: "running", input: { pattern: "spawnSync" }, metadata: {} },
        time: { created: 1, ran: 1 },
      },
    ]),
  ]

  const appeared = subagentChildRows([
    { sessionID: "ses_child", agent: "explore", status: "running", messages: running("grep") },
  ])
  expect(appeared).toHaveLength(1)
  expect(appeared[0]!.tool).toEqual({ name: "grep", args: "spawnSync" })

  const updated = subagentChildRows([
    { sessionID: "ses_child", agent: "explore", status: "running", messages: running("read") },
  ])
  expect(updated[0]!.tool).toEqual({ name: "read", args: "spawnSync" })

  expect(subagentChildRows([{ sessionID: "ses_child", agent: "explore", status: "idle", messages: [] }])).toEqual([])
})

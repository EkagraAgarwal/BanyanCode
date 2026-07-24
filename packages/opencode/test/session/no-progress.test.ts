import { describe, expect, test } from "bun:test"
import { canonicalizeToolBatch, NO_PROGRESS_THRESHOLD, sameFingerprintSet } from "../../src/session/no-progress"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { SessionID, MessageID, PartID } from "../../src/session/schema"

const sessionID = "session_test" as SessionID
const modelID = ModelV2.ID.make("test-model")
const providerID = ProviderV2.ID.make("test")

function baseAssistantInfo(id: string): SessionV1.Assistant {
  return {
    id: id as MessageID,
    sessionID,
    role: "assistant",
    time: { created: 1 },
    parentID: "msg_user" as MessageID,
    modelID,
    providerID,
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function completedToolPart(opts: {
  tool: string
  input: Record<string, unknown>
  callID?: string
  providerExecuted?: boolean
}): SessionV1.ToolPart {
  return {
    id: "prt_test" as PartID,
    messageID: "msg_test" as MessageID,
    sessionID,
    type: "tool",
    callID: opts.callID ?? `call_${Math.random().toString(36).slice(2)}`,
    tool: opts.tool,
    state: {
      status: "completed",
      input: opts.input,
      output: "ok",
      title: opts.tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
    metadata: opts.providerExecuted ? { providerExecuted: true } : undefined,
  }
}

function errorToolPart(opts: {
  tool: string
  input: Record<string, unknown>
  interrupted?: boolean
}): SessionV1.ToolPart {
  return {
    id: "prt_test" as PartID,
    messageID: "msg_test" as MessageID,
    sessionID,
    type: "tool",
    callID: `call_${Math.random().toString(36).slice(2)}`,
    tool: opts.tool,
    state: {
      status: "error",
      input: opts.input,
      error: opts.interrupted ? "Tool execution aborted" : "boom",
      metadata: opts.interrupted ? { interrupted: true } : undefined,
      time: { start: 1, end: 2 },
    },
  }
}

function runningToolPart(opts: { tool: string; input: Record<string, unknown> }): SessionV1.ToolPart {
  return {
    id: "prt_test" as PartID,
    messageID: "msg_test" as MessageID,
    sessionID,
    type: "tool",
    callID: `call_${Math.random().toString(36).slice(2)}`,
    tool: opts.tool,
    state: {
      status: "running",
      input: opts.input,
      title: opts.tool,
      metadata: {},
      time: { start: 1 },
    },
  }
}

function pendingToolPart(opts: { tool: string; input: Record<string, unknown> }): SessionV1.ToolPart {
  return {
    id: "prt_test" as PartID,
    messageID: "msg_test" as MessageID,
    sessionID,
    type: "tool",
    callID: `call_${Math.random().toString(36).slice(2)}`,
    tool: opts.tool,
    state: {
      status: "pending",
      input: opts.input,
      raw: "",
    },
  }
}

function assistantMsg(parts: SessionV1.Part[], id = "msg_test" as MessageID): SessionV1.WithParts {
  return {
    info: baseAssistantInfo(id),
    parts,
  }
}

function textOnlyAssistantMsg(): SessionV1.WithParts {
  return {
    info: baseAssistantInfo("msg_text" as MessageID),
    parts: [
      {
        id: "prt_text" as PartID,
        messageID: "msg_text" as MessageID,
        sessionID,
        type: "text",
        text: "all done",
      },
    ],
  }
}

describe("canonicalizeToolBatch", () => {
  test("exports NO_PROGRESS_THRESHOLD = 3", () => {
    expect(NO_PROGRESS_THRESHOLD).toBe(3)
  })

  test("stable key ordering for objects with shuffled keys", () => {
    const a = canonicalizeToolBatch([assistantMsg([completedToolPart({ tool: "x", input: { b: 2, a: 1 } })])])
    const b = canonicalizeToolBatch([assistantMsg([completedToolPart({ tool: "x", input: { a: 1, b: 2 } })])])
    expect(sameFingerprintSet(a, b)).toBe(true)
    expect([...a]).toEqual([...b])
  })

  test("order-independent across parallel tool calls in one turn", () => {
    const first = canonicalizeToolBatch([
      assistantMsg([
        completedToolPart({ tool: "x", input: { value: "first" } }),
        completedToolPart({ tool: "x", input: { value: "second" } }),
      ]),
    ])
    const swapped = canonicalizeToolBatch([
      assistantMsg([
        completedToolPart({ tool: "x", input: { value: "second" } }),
        completedToolPart({ tool: "x", input: { value: "first" } }),
      ]),
    ])
    expect(sameFingerprintSet(first, swapped)).toBe(true)
  })

  test("duplicate-call multiplicity: two equal calls produce one key", () => {
    const set = canonicalizeToolBatch([
      assistantMsg([
        completedToolPart({ tool: "x", input: { a: 1 } }),
        completedToolPart({ tool: "x", input: { a: 1 } }),
      ]),
    ])
    expect(set.size).toBe(1)
  })

  test("completed-vs-error status divergence produces different keys", () => {
    const completed = canonicalizeToolBatch([
      assistantMsg([completedToolPart({ tool: "x", input: { a: 1 } })]),
    ])
    const errored = canonicalizeToolBatch([
      assistantMsg([errorToolPart({ tool: "x", input: { a: 1 } })]),
    ])
    expect(sameFingerprintSet(completed, errored)).toBe(false)
    expect(completed.size).toBe(1)
    expect(errored.size).toBe(1)
  })

  test("running and pending tool parts are excluded from the fingerprint", () => {
    const runningOnly = canonicalizeToolBatch([
      assistantMsg([runningToolPart({ tool: "x", input: { a: 1 } })]),
    ])
    const pendingOnly = canonicalizeToolBatch([
      assistantMsg([pendingToolPart({ tool: "x", input: { a: 1 } })]),
    ])
    expect(runningOnly.size).toBe(0)
    expect(pendingOnly.size).toBe(0)
  })

  test("provider-executed tool parts are excluded", () => {
    const providerExecuted = canonicalizeToolBatch([
      assistantMsg([completedToolPart({ tool: "x", input: { a: 1 }, providerExecuted: true })]),
    ])
    expect(providerExecuted.size).toBe(0)
  })

  test("interrupted-orphan tool parts are excluded", () => {
    const interrupted = canonicalizeToolBatch([
      assistantMsg([errorToolPart({ tool: "x", input: { a: 1 }, interrupted: true })]),
    ])
    expect(interrupted.size).toBe(0)
  })

  test("non-orphan error tool parts ARE included in the fingerprint", () => {
    const errored = canonicalizeToolBatch([
      assistantMsg([errorToolPart({ tool: "x", input: { a: 1 } })]),
    ])
    expect(errored.size).toBe(1)
  })

  test("empty input still produces a distinct stable key", () => {
    const a = canonicalizeToolBatch([assistantMsg([completedToolPart({ tool: "x", input: {} })])])
    const b = canonicalizeToolBatch([assistantMsg([completedToolPart({ tool: "x", input: {} })])])
    expect(a.size).toBe(1)
    expect(b.size).toBe(1)
    expect(sameFingerprintSet(a, b)).toBe(true)
  })

  test("callID and messageID do not affect the fingerprint", () => {
    const a = canonicalizeToolBatch([
      assistantMsg([completedToolPart({ tool: "x", input: { a: 1 }, callID: "call-a" })], "msg_a" as MessageID),
    ])
    const b = canonicalizeToolBatch([
      assistantMsg([completedToolPart({ tool: "x", input: { a: 1 }, callID: "call-b" })], "msg_b" as MessageID),
    ])
    expect(sameFingerprintSet(a, b)).toBe(true)
  })

  test("text-only assistant turns produce an empty fingerprint set", () => {
    const set = canonicalizeToolBatch([textOnlyAssistantMsg()])
    expect(set.size).toBe(0)
  })

  test("different tool names produce different fingerprints", () => {
    const a = canonicalizeToolBatch([assistantMsg([completedToolPart({ tool: "x", input: { a: 1 } })])])
    const b = canonicalizeToolBatch([assistantMsg([completedToolPart({ tool: "y", input: { a: 1 } })])])
    expect(sameFingerprintSet(a, b)).toBe(false)
  })

  test("nested objects are deep-sorted by key", () => {
    const a = canonicalizeToolBatch([
      assistantMsg([
        completedToolPart({
          tool: "x",
          input: { outer: { z: 1, a: 2, m: { y: 1, b: 2 } } },
        }),
      ]),
    ])
    const b = canonicalizeToolBatch([
      assistantMsg([
        completedToolPart({
          tool: "x",
          input: { outer: { m: { b: 2, y: 1 }, a: 2, z: 1 } },
        }),
      ]),
    ])
    expect(sameFingerprintSet(a, b)).toBe(true)
  })

  test("arrays preserve insertion order in the fingerprint", () => {
    const first = canonicalizeToolBatch([
      assistantMsg([completedToolPart({ tool: "x", input: { list: [1, 2, 3] } })]),
    ])
    const reordered = canonicalizeToolBatch([
      assistantMsg([completedToolPart({ tool: "x", input: { list: [3, 2, 1] } })]),
    ])
    expect(sameFingerprintSet(first, reordered)).toBe(false)
  })

  test("sameFingerprintSet handles size mismatch", () => {
    const a = new Set(["x", "y"])
    const b = new Set(["x"])
    expect(sameFingerprintSet(a, b)).toBe(false)
  })
})
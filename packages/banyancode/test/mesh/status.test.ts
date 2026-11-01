import { describe, expect, test } from "bun:test"
import {
  buildForest,
  countRunningDescendants,
  descendantsOf,
  reduceLiveStatus,
  removeSnapshot,
  rootOf,
  stateOf,
  treeFor,
  upsertSnapshot,
  type LiveState,
} from "../../src/mesh/status.js"
import { emptyTokens, type MeshSessionSnapshot } from "../../src/mesh/types.js"

const snapshot = (
  sessionID: string,
  overrides: Partial<MeshSessionSnapshot> = {},
): MeshSessionSnapshot => ({
  sessionID,
  title: `Session ${sessionID}`,
  agent: sessionID === "root" ? "orchestrator" : "coder",
  cost: 0,
  tokens: emptyTokens(),
  createdAt: 1_000,
  updatedAt: 2_000,
  ...overrides,
})

const fixture = () => {
  const sessions = new Map<string, MeshSessionSnapshot>()
  sessions.set("root", snapshot("root", { agent: "orchestrator" }))
  sessions.set("coder-1", snapshot("coder-1", { parentID: "root", agent: "coder" }))
  sessions.set("explore-1", snapshot("explore-1", { parentID: "coder-1", agent: "explore" }))
  sessions.set("coder-2", snapshot("coder-2", { parentID: "root", agent: "coder", updatedAt: 1_900 }))
  return sessions
}

describe("mesh status tree", () => {
  test("buildForest nests children and carries cost/tokens", () => {
    const sessions = fixture()
    sessions.set(
      "coder-1",
      snapshot("coder-1", {
        parentID: "root",
        agent: "coder",
        cost: 1.25,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 3, write: 4 } },
        busyAt: 1_500,
        idleAt: 1_400,
      }),
    )
    const roots = buildForest(sessions)
    expect(roots.map((node) => node.sessionID)).toEqual(["root"])
    const root = roots[0]!
    expect(root.children.map((node) => node.sessionID).sort()).toEqual(["coder-1", "coder-2"])
    const coder = root.children.find((node) => node.sessionID === "coder-1")!
    expect(coder.state).toBe("running")
    expect(coder.cost).toBe(1.25)
    expect(coder.tokens.input).toBe(100)
    expect(coder.children.map((node) => node.sessionID)).toEqual(["explore-1"])
  })

  test("treeFor scopes a subtree and descendantsOf walks depth-first", () => {
    const sessions = fixture()
    const node = treeFor(sessions, "coder-1")
    expect(node?.sessionID).toBe("coder-1")
    expect(node?.children.map((child) => child.sessionID)).toEqual(["explore-1"])
    expect(descendantsOf(sessions, "root").map((session) => session.sessionID).sort()).toEqual([
      "coder-1",
      "coder-2",
      "explore-1",
    ])
  })

  test("session event fixtures drive running -> retry -> idle -> failed states", () => {
    const sessions = new Map<string, MeshSessionSnapshot>()
    sessions.set("root", snapshot("root", { agent: "orchestrator" }))
    sessions.set("child", snapshot("child", { parentID: "root", agent: "coder" }))
    let live: ReadonlyMap<string, LiveState> = new Map()

    live = reduceLiveStatus(live, { type: "session.execution.started", sessionID: "child" })
    expect(stateOf(sessions.get("child")!, live.get("child"))).toBe("running")
    expect(countRunningDescendants(sessions, "root", live)).toBe(1)

    live = reduceLiveStatus(live, { type: "session.status", sessionID: "child", status: "retry" })
    expect(stateOf(sessions.get("child")!, live.get("child"))).toBe("retry")
    expect(countRunningDescendants(sessions, "root", live)).toBe(0)

    sessions.set("child", snapshot("child", { parentID: "root", agent: "coder", idleAt: 3_000, outcome: "succeeded" }))
    live = reduceLiveStatus(live, { type: "session.execution.succeeded", sessionID: "child" })
    expect(stateOf(sessions.get("child")!, live.get("child"))).toBe("idle")

    sessions.set("child", snapshot("child", { parentID: "root", agent: "coder", idleAt: 3_000, outcome: "failed" }))
    live = reduceLiveStatus(live, { type: "session.execution.failed", sessionID: "child" })
    expect(stateOf(sessions.get("child")!, live.get("child"))).toBe("failed")
    expect(buildForest(sessions, live)[0]?.children[0]?.state).toBe("failed")
  })

  test("upsert/remove/rootOf keep the tree cache coherent on session events", () => {
    let sessions = fixture()
    expect(rootOf(sessions, "explore-1")).toBe("root")
    sessions = removeSnapshot(sessions, "coder-1")
    // Removing a parent re-parents orphaned children as roots.
    expect(rootOf(sessions, "explore-1")).toBe("explore-1")
    sessions = upsertSnapshot(sessions, snapshot("explore-1", { parentID: "root", agent: "explore" }))
    expect(rootOf(sessions, "explore-1")).toBe("root")
  })
})

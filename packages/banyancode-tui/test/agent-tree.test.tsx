/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { AgentTreePanel } from "../src/components/sidebar/agent-tree"
import { AgentTreeView, buildAgentTree, flattenAgentTree } from "../src/components/panels/agents"
import { assistant, context, meshLive, mount, session } from "./harness"

function fixture() {
  const root = session({ id: "ses_root", title: "orchestrate the migration" })
  const first = session({ id: "ses_a", parentID: "ses_root", title: "port sidebar", agent: "coder" })
  const second = session({ id: "ses_b", parentID: "ses_root", title: "write parity rows", agent: "coder" })
  return {
    root,
    sessions: [root, first, second],
    messages: {
      ses_a: [assistant([{ name: "read" }, { name: "grep" }])],
      ses_b: [assistant([{ name: "edit" }])],
    },
  }
}

test("sidebar agent tree lists direct children with tools", async () => {
  const data = fixture()
  const app = await mount(
    () => (
      <AgentTreePanel
        context={context({ sessions: data.sessions, messages: data.messages })}
        sessionID="ses_root"
        mesh={meshLive()}
      />
    ),
    { width: 80, height: 20 },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("AGENT TREE")
    expect(frame).toContain("orchestrator")
    expect(frame).toContain("port sidebar")
    expect(frame).toContain("write parity rows")
    expect(frame).toContain("tools: read, grep")
    expect(frame).toContain("├─")
    expect(frame).toContain("└─")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar agent tree counts running children and marks killed ones finished", async () => {
  const data = fixture()
  const app = await mount(
    () => (
      <AgentTreePanel
        context={context({ sessions: data.sessions, running: new Set(["ses_a"]) })}
        sessionID="ses_root"
        mesh={meshLive({ killed: ["ses_b"] })}
      />
    ),
    { width: 80, height: 20 },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("● 1 active")
    expect(frame).not.toContain("2 active")
    expect(frame).toContain("killed")
    expect(frame).not.toContain("ses_b succeeded")
  } finally {
    app.renderer.destroy()
  }
})

test("agent tree stats fold child cost and tokens into the root", () => {
  const data = fixture()
  const tree = buildAgentTree({
    sessions: data.sessions,
    rootID: "ses_root",
    stateOf: (sessionID) => (sessionID === "ses_a" ? "running" : "done"),
  })
  expect(tree).toBeDefined()
  expect(tree!.children).toHaveLength(2)
  expect(tree!.isPathToRunning).toBe(true)
  expect(tree!.children[0]!.status).toBe("running")
  expect(flattenAgentTree(tree!).map((row) => row.kind)).toEqual(["node", "node", "node"])
})

test("killed sessions are finished in the full agent tree", () => {
  const data = fixture()
  const tree = buildAgentTree({
    sessions: data.sessions,
    rootID: "ses_root",
    stateOf: () => "running",
    killed: new Set(["ses_a"]),
  })
  const killed = tree!.children.find((child) => child.session.id === "ses_a")!
  expect(killed.killed).toBe(true)
  expect(killed.status).toBe("done")
  expect(killed.isPathToRunning).toBe(false)
})

test("full agent tree view renders session rows", async () => {
  const data = fixture()
  const app = await mount(
    () => <AgentTreeView context={context({ sessions: data.sessions })} sessionID="ses_root" mesh={meshLive()} />,
    { width: 80, height: 20 },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Agent Tree")
    expect(frame).toContain("3 sessions")
    expect(frame).toContain("coder")
    expect(frame).toContain("2 subs")
  } finally {
    app.renderer.destroy()
  }
})

test("full agent tree view labels killed children finished", async () => {
  const data = fixture()
  const app = await mount(
    () => (
      <AgentTreeView
        context={context({ sessions: data.sessions })}
        sessionID="ses_root"
        mesh={meshLive({ killed: ["ses_b"] })}
      />
    ),
    { width: 80, height: 20 },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame.split("\n").some((line) => line.includes("coder") && line.includes("killed"))).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

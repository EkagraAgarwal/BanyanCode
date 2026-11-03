/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { AgentTreePanel } from "../src/components/sidebar/agent-tree"
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

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { AgentsPanel } from "../src/components/sidebar/agents"
import { context, meshLive, meshNode, mount } from "./harness"

test("subagent row shows the agent and its state without cost or tokens", async () => {
  const app = await mount(
    () => (
      <box width={40}>
        <AgentsPanel
          context={context()}
          sessionID="ses_root"
          mesh={meshLive({
            root: meshNode({
              sessionID: "ses_root",
              state: "running",
              children: [
                meshNode({
                  sessionID: "ses_child",
                  state: "running",
                  agent: "coder",
                  cost: 0.42,
                  tokens: { input: 15_600_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } },
                }),
              ],
            }),
          })}
        />
      </box>
    ),
    { width: 40, height: 10 },
  )
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("coder")
    expect(frame).toContain("[active]")
    expect(frame).not.toContain("$")
    expect(frame).not.toContain("tok")
  } finally {
    app.renderer.destroy()
  }
})

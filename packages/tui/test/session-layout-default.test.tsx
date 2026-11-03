import { expect, test } from "bun:test"
import type { SessionInfo } from "@opencode/client"
import type { Config } from "../src/config"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

/**
 * The owner kept the classic chat page: with no `session_layout` set, the shared
 * header and footer are the v2-base ones and the side columns dock. Trunk is
 * opt-in and still shows its two-row chrome with the canopy rule and the rail.
 */
const session = {
  id: "ses_layout_default",
  title: "Greeting",
  projectID: "proj_layout",
  location: { directory },
  agent: "build",
  model: { providerID: "fixture", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
} satisfies SessionInfo

const messages = [
  { id: "msg_layout_user", type: "user", text: "Refactor the parser", time: { created: 1 } },
  {
    id: "msg_layout_assistant",
    type: "assistant",
    agent: "build",
    model: { providerID: "fixture", id: "model" },
    time: { created: 2, completed: 3 },
    content: [{ type: "text", text: "The tokenizer is ready." }],
  },
]

async function render(layout: Config.Info["session_layout"]) {
  return createAppFixture({
    width: 160,
    height: 50,
    config: { animations: false, tabs: { mode: "on" }, session_layout: layout },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages, cursor: {} })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      return undefined
    },
  })
}

test("the chat page defaults to the classic layout", async () => {
  await using setup = await render(undefined)
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("SESSIONS") && frame.includes("Refactor the parser"), {
    maxPasses: 200,
  })
  await setup.waitForVisualIdle({ quietFrames: 3 })
  const frame = setup.captureCharFrame()
  // Row 0 is the host's session tab strip; the shared chrome starts at row 1.
  const [, header, tabs, rule] = frame.split("\n")
  expect(header).toContain("BANYANCODE")
  expect(header).not.toContain("CHAT")
  expect(header).toContain("ctrl+p commands ctrl+] tabs")
  expect(tabs).toContain("CHAT")
  expect(tabs).toContain("SESSIONS")
  expect(rule!.replace(/[─\s]/g, "")).toBe("")
  expect(frame).toContain("▲ 0 need attention")
  expect(frame).toContain("^p cmd · / search")
  // The classic side columns dock: the sidebar and the inspector are both bordered.
  expect(frame).toContain("AGENT DETAILS")
  expect(frame).toContain("PERFORMANCE")
  // No canopy rule and no Trunk rail root.
  expect(frame).not.toContain("━")
  expect(frame).not.toContain("◉")
})

test("session_layout trunk keeps the two-row chrome and the rail", async () => {
  await using setup = await render("trunk")
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("SESSIONS") && frame.includes("Refactor the parser"), {
    maxPasses: 200,
  })
  await setup.waitForVisualIdle({ quietFrames: 3 })
  const frame = setup.captureCharFrame()
  const [, header, canopy] = frame.split("\n")
  // Row 1 carries the tabs; row 2 is the canopy rule, not a second label row.
  expect(header).toContain("CHAT")
  expect(header).toContain("SESSIONS")
  expect(header).toContain("banyancode")
  expect(canopy!.replace(/[─━\s]/g, "")).toBe("")
  expect(canopy).toContain("━")
  // The rail replaces the sidebar in the same docked column.
  expect(frame).toContain("◉")
  expect(frame).not.toContain("PERFORMANCE")
  // The Trunk footer shows the attention count only while something waits.
  expect(frame).not.toContain("need attention")
  expect(frame).not.toContain("^p cmd · / search")
})

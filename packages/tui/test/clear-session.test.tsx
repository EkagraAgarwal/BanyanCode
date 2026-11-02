import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const location = { directory, project: { id: "project", directory, canonical: directory } }
const session = {
  id: "ses_clear",
  title: "Session to clear",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

function render(state: string) {
  return createAppFixture({
    state,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "on" } },
    fetch: (url) => {
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }],
        })
    },
  })
}

test("/clear replaces the active session tab", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path)

  await setup.waitForFrame((frame) => frame.includes("Session to clear"))
  await setup.mockInput.typeText("/clear")
  setup.mockInput.pressEnter()
  // Home lists the session it no longer has open in its resume block, so the frame
  // cannot show that the tab closed. The tab store records what is open.
  const tabs = path.join(state.path, "test", "tui", "tabs.json")
  const locks = path.join(state.path, "test", "locks")
  const open = () => {
    try {
      const stored = JSON.parse(readFileSync(tabs, "utf8")) as { global?: { tabs?: Array<{ sessionID: string }> } }
      return stored.global?.tabs
    } catch {
      return undefined
    }
  }
  const writing = () => {
    try {
      return readdirSync(locks).length > 0
    } catch {
      return false
    }
  }
  await setup.waitForFrame((frame) => frame.includes("RESUME") && frame.includes("Session to clear"))
  // The close and the resume block's title sync both update the tab store. Stop once
  // several consecutive frames see the session gone and no flock held.
  let quiet = 0
  await setup.waitFor(() => {
    const list = open()
    const settled = list !== undefined && list.every((tab) => tab.sessionID !== session.id) && !writing()
    quiet = settled ? quiet + 1 : 0
    return quiet >= 3
  })
  expect(open()?.map((tab) => tab.sessionID)).not.toContain(session.id)
})

test("/new keeps the active session tab", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path)

  await setup.waitForFrame((frame) => frame.includes("Session to clear"))
  await setup.mockInput.typeText("/new")
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame(
    (frame) => frame.includes("New session") && frame.includes("Session to clear"),
  )

  expect(frame).toContain("Session to clear")
})

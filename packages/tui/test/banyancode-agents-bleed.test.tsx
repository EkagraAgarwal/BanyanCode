import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import type { SessionInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

const NOW = Date.now()

function fixtureSessions() {
  const token = crypto.randomUUID()
  const root: SessionInfo = {
    id: `ses_bleed_root_${token}`,
    title: "Bleed fixture",
    projectID: "proj_bleed",
    location: { directory },
    agent: "build",
    model: { providerID: "fixture", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: NOW - 10_000, updated: NOW, busy: NOW - 10_000, idle: NOW - 1_000 },
  }
  const child: SessionInfo = {
    id: `ses_bleed_child_${token}`,
    parentID: root.id,
    title: "Rewrite the fallback",
    projectID: root.projectID,
    location: { directory },
    agent: "coder",
    model: { providerID: "fixture", id: "model" },
    cost: 0,
    tokens: { input: 12_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: NOW - 9_000, updated: NOW - 2_000, idle: NOW - 2_000 },
  }
  const messages = (sessionID: string) => [
    {
      id: `${sessionID}_user`,
      type: "user",
      text: sessionID === root.id ? "root prompt" : "child prompt",
      time: { created: NOW - 8_000 },
    },
  ]
  return { root, child, messages }
}

async function fixture(input: {
  readonly width: number
  readonly height: number
  readonly layout: "classic" | "trunk"
}) {
  const { root, child, messages } = fixtureSessions()
  const setup = await createAppFixture({
    width: input.width,
    height: input.height,
    args: { sessionID: root.id },
    config: {
      animations: false,
      session_layout: input.layout,
      tabs: { mode: "on" },
      session: { sidebar: "auto" },
    },
    fetch: async (url) => {
      if (url.pathname === "/api/location")
        return json({ directory, project: { id: root.projectID, directory, canonical: directory } })
      if (url.pathname === "/api/agent")
        return json({ location: { directory }, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model")
        return json({ location: { directory }, data: [{ id: "model", providerID: "fixture", name: "Model", variants: [] }] })
      if (url.pathname === "/api/provider") return json({ location: { directory }, data: [{ id: "fixture", name: "Fixture" }] })
      if (url.pathname === "/api/vcs") return json({ location: { directory }, data: { branch: { current: "dev", default: "dev" } } })
      if (url.pathname === "/api/session") return json({ data: [root, child], cursor: {} })
      if (url.pathname === `/api/session/${root.id}`) return json({ data: root })
      if (url.pathname === `/api/session/${child.id}`) return json({ data: child })
      if (url.pathname.endsWith("/message")) {
        const id = url.pathname.split("/")[3] ?? ""
        return json({ data: messages(id), cursor: {} })
      }
      if (url.pathname.endsWith("/inbox")) return json({ data: [] })
      if (url.pathname.endsWith("/permission")) return json({ data: [] })
      if (url.pathname.endsWith("/form")) return json({ data: [] })
      if (url.pathname.endsWith("/prompt")) return json({ data: {} })
      if (url.pathname.endsWith("/view")) return json({ data: {} })
      return undefined
    },
  })
  return setup
}

type Setup = Awaited<ReturnType<typeof fixture>>

async function ready(setup: Setup) {
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("root prompt"), { maxPasses: 200 })
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
}

const box = (setup: Setup, id: string) => setup.renderer.root.findDescendantById(id)

/** One view forward: CHAT -> SESSIONS -> AGENTS -> CONFIG. */
async function nextView(setup: Setup) {
  setup.mockInput.pressKey("]", { ctrl: true })
  await setup.waitForVisualIdle({ quietFrames: 2 })
}

/** One view back: CONFIG -> AGENTS -> SESSIONS -> CHAT. */
async function previousView(setup: Setup) {
  setup.mockInput.pressKey("[", { ctrl: true })
  await setup.waitForVisualIdle({ quietFrames: 2 })
}

/** The composer's top border, the lowest rounded corner in the frame. */
function composerLeft(frame: string) {
  const row = frame.split("\n").filter((line) => line.includes("╭")).at(-1)
  return row ? row.indexOf("╭") : -1
}

const cases = [
  { layout: "classic", width: 160, height: 40 },
  { layout: "trunk", width: 120, height: 30 },
] as const

for (const item of cases) {
  test(`the Agents tab is full-bleed in the ${item.layout} layout`, async () => {
    await using setup = await fixture(item)
    await ready(setup)
    await setup.waitForVisualIdle({ quietFrames: 2 })

    const chat = box(setup, "session-pane")
    if (!chat) throw new Error("missing session pane")
    const chatX = chat.x
    const chatWidth = chat.width
    // The baseline really is a docked column: the classic sidebar, or the Trunk rail.
    expect(chatX).toBeGreaterThan(0)
    expect(box(setup, "session-sidebar-scroll") !== undefined).toBe(item.layout === "classic")
    // The composer keeps the reading gutter here; bleeding removes it.
    expect(composerLeft(setup.captureCharFrame())).toBeGreaterThanOrEqual(2)
    // The app's session tab strip is the top row, above the chrome.
    const first = setup.captureCharFrame().split("\n")[0]
    expect(first).toContain("Bleed fixture")
    expect(setup.captureCharFrame()).toContain(item.layout === "classic" ? "BANYANCODE" : "banyancode")

    // SESSIONS opens in the main area and keeps the side columns.
    await nextView(setup)
    expect(box(setup, "session-panel") !== undefined).toBe(true)
    expect(box(setup, "session-pane")?.x).toBe(chatX)

    // AGENTS takes the whole width: both columns and their rails step aside.
    await nextView(setup)
    await setup.waitFor(() => box(setup, "session-pane")?.x === 0, { maxPasses: 100 })
    await setup.waitFor(() => box(setup, "session-panel")?.width === item.width, { maxPasses: 100 })
    await setup.waitForVisualIdle({ quietFrames: 2 })
    const solo = box(setup, "session-pane")
    expect(solo?.x).toBe(0)
    expect(solo?.width).toBe(item.width)
    expect(box(setup, "session-panel")?.width).toBe(item.width)
    expect(box(setup, "session-sidebar-scroll")).toBeUndefined()
    // No gutter: the composer's own border is all that is left of the inset.
    expect(composerLeft(setup.captureCharFrame())).toBeLessThan(2)

    // The canopy chrome replaces the layout's own, whatever session_layout says.
    const frame = setup.captureCharFrame()
    expect(frame.split("\n").some((line) => line.includes("━"))).toBe(true)
    expect(frame).not.toContain("need attention")
    if (item.layout === "classic") {
      expect(frame).not.toContain("BANYANCODE")
      expect(frame).toContain("banyancode")
    }

    // Back on SESSIONS the side columns return: only the Agents tab bleeds.
    await previousView(setup)
    await setup.waitFor(() => box(setup, "session-pane")?.x === chatX, { maxPasses: 100 })
    expect(box(setup, "session-sidebar-scroll") !== undefined).toBe(item.layout === "classic")

    // Back on CHAT the sidebars are exactly where they were.
    await previousView(setup)
    await setup.waitFor(() => box(setup, "session-panel") === undefined, { maxPasses: 100 })
    // The painted frame lags the tree, so wait for the restored chrome before reading it.
    await setup.waitForFrame((frame) => frame.includes("BANYANCODE") || frame.includes("banyancode"), {
      maxPasses: 100,
    })
    await setup.waitForVisualIdle({ quietFrames: 2 })
    expect(box(setup, "session-pane")?.x).toBe(chatX)
    expect(box(setup, "session-pane")?.width).toBe(chatWidth)
    expect(composerLeft(setup.captureCharFrame())).toBeGreaterThanOrEqual(2)
    expect(setup.captureCharFrame()).toContain(item.layout === "classic" ? "BANYANCODE" : "banyancode")
  })
}

import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import type { SessionInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

const NOW = Date.now()

function fixtureSessions() {
  const token = crypto.randomUUID()
  const root: SessionInfo = {
    id: `ses_understory_root_${token}`,
    title: "Understory fixture",
    projectID: "proj_understory",
    location: { directory },
    agent: "build",
    model: { providerID: "fixture", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: NOW - 10_000, updated: NOW, busy: NOW - 10_000, idle: NOW - 1_000 },
  }

  const coder: SessionInfo = {
    id: `ses_understory_coder_${token}`,
    parentID: root.id,
    title: "Rewrite the fallback",
    projectID: root.projectID,
    location: { directory },
    agent: "coder",
    model: { providerID: "fixture", id: "model" },
    cost: 0.01,
    tokens: { input: 12_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: NOW - 9_000, updated: NOW - 2_000, idle: NOW - 2_000 },
  }

  const explore: SessionInfo = {
    id: `ses_understory_explore_${token}`,
    parentID: root.id,
    title: "Trace the resolver",
    projectID: root.projectID,
    location: { directory },
    agent: "explore",
    model: { providerID: "fixture", id: "model" },
    cost: 0,
    tokens: { input: 8_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: NOW - 8_500, updated: NOW - 2_000, idle: NOW - 2_000 },
  }

  const messages = (sessionID: string) => {
    const text = sessionID === root.id ? "root prompt" : sessionID === coder.id ? "coder prompt" : "explore prompt"
    return [
      {
        id: `${sessionID}_user`,
        type: "user",
        text,
        time: { created: NOW - 8_000 },
      },
    ]
  }

  return { root, coder, explore, messages }
}

async function fixture(input: { readonly width: number; readonly height: number }) {
  const { root, coder, explore, messages } = fixtureSessions()
  const setup = await createAppFixture({
    width: input.width,
    height: input.height,
    args: { sessionID: root.id },
    config: {
      animations: false,
      tabs: { mode: "on" },
      session: { sidebar: "hide" },
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
      if (url.pathname === "/api/session") return json({ data: [root, coder, explore], cursor: {} })
      if (url.pathname === `/api/session/${root.id}`) return json({ data: root })
      if (url.pathname === `/api/session/${coder.id}`) return json({ data: coder })
      if (url.pathname === `/api/session/${explore.id}`) return json({ data: explore })
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

async function ready(setup: Awaited<ReturnType<typeof fixture>>) {
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("root prompt"), { maxPasses: 200 })
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
}

async function openAgents(setup: Awaited<ReturnType<typeof fixture>>) {
  setup.mockInput.pressKey("]", { ctrl: true })
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable?.id === "session-panel")
  setup.mockInput.pressKey("]", { ctrl: true })
  await setup.waitForFrame(
    (frame) => frame.includes("1 Trace") && (frame.includes("BRANCHES") || frame.includes("BRCH")),
    { maxPasses: 200 },
  )
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable?.id === "session-panel")
}

function selectedRow(setup: Awaited<ReturnType<typeof fixture>>) {
  return setup.captureCharFrame().split("\n").find((line) => line.includes("▌")) ?? ""
}

test("the Agents tab owns real keys: j/k, Esc, Tab and the composer", async () => {
  await using setup = await fixture({ width: 220, height: 45 })
  await ready(setup)
  const prompt = setup.renderer.currentFocusedEditor
  if (!(prompt instanceof TextareaRenderable)) throw new Error("missing prompt")
  await openAgents(setup)

  // j/k move the roster, and nothing lands in the composer.
  setup.mockInput.pressKey("j")
  await setup.waitFor(() => selectedRow(setup).includes("coder"))
  expect(selectedRow(setup)).toContain("coder")
  expect(selectedRow(setup)).not.toContain("explore")
  expect(prompt.plainText).toBe("")

  setup.mockInput.pressKey("k")
  await setup.waitFor(() => selectedRow(setup).includes("build"))
  expect(prompt.plainText).toBe("")

  // Esc backs out one level at a time and then closes the panel.
  setup.mockInput.pressKey("?")
  await setup.waitForFrame((frame) => frame.includes("close this list"), { maxPasses: 100 })
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("close this list"), { maxPasses: 100 })
  expect(setup.captureCharFrame()).toContain("1 Trace")

  setup.mockInput.pressKey("3")
  await setup.waitForFrame((frame) => frame.includes("All branches"), { maxPasses: 100 })
  setup.mockInput.pressKey("f")
  await setup.waitForFrame((frame) => frame.includes("build only"), { maxPasses: 100 })
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes("All branches"), { maxPasses: 100 })
  expect(setup.captureCharFrame()).toContain("1 Trace")

  setup.mockInput.pressEscape()
  await setup.waitFor(() => setup.renderer.root.findDescendantById("session-panel") === undefined)
  await setup.waitForFrame((frame) => frame.includes("root prompt"), { maxPasses: 100 })
  await setup.waitForVisualIdle({ quietFrames: 3 })

  const settled = setup.captureCharFrame()
  setup.mockInput.pressEscape()
  await setup.waitForVisualIdle({ quietFrames: 3 })
  expect(setup.captureCharFrame()).toBe(settled)

  // Tab moves focus to the composer; a and x are text, not panel actions.
  await openAgents(setup)
  setup.mockInput.pressKey("j")
  await setup.waitFor(() => selectedRow(setup).includes("coder"))
  setup.mockInput.pressTab()
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
  setup.mockInput.typeText("ax")
  await setup.waitForFrame((frame) => frame.includes("ax"), { maxPasses: 100 })
  expect(prompt.plainText).toBe("ax")
  const composed = setup.captureCharFrame()
  expect(composed).not.toContain("press x again")
  expect(composed).not.toContain("press w to jump")

  // Clicking the panel restores its keys; one press moves exactly one row.
  const panel = setup.renderer.root.findDescendantById("session-panel")
  if (!panel) throw new Error("missing panel")
  await setup.mockMouse.click(panel.x + 3, panel.y + 3)
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable?.id === "session-panel")
  setup.mockInput.pressKey("k")
  await setup.waitFor(() => selectedRow(setup).includes("build"))
  expect(prompt.plainText).toBe("ax")

  // Leave and re-enter: no duplicate layers, so one press is still one row.
  setup.mockInput.pressEscape()
  await setup.waitFor(() => setup.renderer.root.findDescendantById("session-panel") === undefined)
  await openAgents(setup)
  setup.mockInput.pressKey("j")
  await setup.waitFor(() => selectedRow(setup).includes("coder"))
  expect(selectedRow(setup)).toContain("coder")
  expect(selectedRow(setup)).not.toContain("explore")
})

test("entering the Agents tab lands on Trace, and the lens keys are only digits", async () => {
  await using setup = await fixture({ width: 220, height: 45 })
  await ready(setup)
  const prompt = setup.renderer.currentFocusedEditor
  if (!(prompt instanceof TextareaRenderable)) throw new Error("missing prompt")
  await openAgents(setup)

  // The tab opens on the Trace lens: its ruler, not the stream's filter row.
  const entered = setup.captureCharFrame()
  expect(entered).toContain("NOW")
  expect(entered).not.toContain("All branches")

  // 3 and 1 switch lenses through the real dispatcher.
  setup.mockInput.pressKey("3")
  await setup.waitForFrame((frame) => frame.includes("All branches"), { maxPasses: 100 })
  setup.mockInput.pressKey("1")
  await setup.waitForFrame((frame) => frame.includes("NOW") && !frame.includes("All branches"), { maxPasses: 100 })

  // A key event whose base-layout key is a digit is not a digit press: the
  // kitty sequence below is `]` with no modifiers but base key "3", which is
  // the shape a tab switch carries. It must not reach the lens keys.
  setup.renderer.stdin.emit("data", Buffer.from("\x1b[93;1;51u"))
  await setup.waitForVisualIdle({ quietFrames: 2 })
  expect(setup.captureCharFrame()).toContain("NOW")
  expect(setup.captureCharFrame()).not.toContain("All branches")

  // Digits typed into the composer stay digits and never pick a lens.
  setup.mockInput.pressTab()
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
  setup.mockInput.typeText("213")
  await setup.waitForFrame((frame) => frame.includes("213"), { maxPasses: 100 })
  expect(prompt.plainText).toBe("213")
  const typed = setup.captureCharFrame()
  expect(typed).toContain("NOW")
  expect(typed).not.toContain("All branches")
})

test("the app frames keep the panel status row under the composer", async () => {
  for (const [width, height] of [
    [120, 40],
    [80, 24],
  ] as const) {
    await using setup = await fixture({ width, height })
    await ready(setup)
    const prompt = setup.renderer.currentFocusedEditor
    if (!(prompt instanceof TextareaRenderable)) throw new Error("missing prompt")
    await openAgents(setup)
    setup.mockInput.pressKey("3")
    await setup.waitForFrame((frame) => frame.includes("All branches"), { maxPasses: 100 })
    const frame = setup.captureCharFrame()
    const lines = frame.split("\n")
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(width)
    const hints = lines.findIndex((line) => line.includes("w next"))
    expect(hints).toBeGreaterThan(-1)
    expect(lines[hints]).toContain("? keys")
    // The tab publishes its hints to the host status row, so they sit under
    // the composer instead of spending a panel row above it.
    expect(hints).toBeGreaterThan(prompt.y + prompt.height)
    expect(prompt.y + prompt.height).toBeLessThanOrEqual(height)
    expect(lines[hints]).toContain("Git:")
    expect(frame.toLowerCase()).toContain("banyancode")
    expect(frame.includes("BRANCHES") || frame.includes("BRCH")).toBe(true)
  }
})

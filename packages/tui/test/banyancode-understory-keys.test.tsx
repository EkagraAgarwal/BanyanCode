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
    (frame) => frame.includes("Trace") && (frame.includes("BRANCHES") || frame.includes("BRCH")),
    { maxPasses: 200 },
  )
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable?.id === "session-panel")
}

function selectedRow(setup: Awaited<ReturnType<typeof fixture>>) {
  return setup.captureCharFrame().split("\n").find((line) => line.includes("▌")) ?? ""
}

test("the Agents tab listens only to list keys, and Esc and Tab still work", async () => {
  await using setup = await fixture({ width: 220, height: 45 })
  await ready(setup)
  const prompt = setup.renderer.currentFocusedEditor
  if (!(prompt instanceof TextareaRenderable)) throw new Error("missing prompt")
  await openAgents(setup)

  // Down/Up move the roster selection, and nothing lands in the composer.
  setup.mockInput.pressArrow("down")
  await setup.waitFor(() => selectedRow(setup).includes("coder"))
  expect(selectedRow(setup)).toContain("coder")
  expect(prompt.plainText).toBe("")

  setup.mockInput.pressArrow("up")
  await setup.waitFor(() => selectedRow(setup).includes("build"))
  expect(prompt.plainText).toBe("")

  // Esc backs out and then closes the panel.
  setup.mockInput.pressEscape()
  await setup.waitFor(() => setup.renderer.root.findDescendantById("session-panel") === undefined)
  await setup.waitForFrame((frame) => frame.includes("root prompt"), { maxPasses: 100 })
  await setup.waitForVisualIdle({ quietFrames: 3 })

  const settled = setup.captureCharFrame()
  setup.mockInput.pressEscape()
  await setup.waitForVisualIdle({ quietFrames: 3 })
  expect(setup.captureCharFrame()).toBe(settled)

  // Tab hands the keyboard to the composer.
  await openAgents(setup)
  setup.mockInput.pressTab()
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
  setup.mockInput.typeText("ax")
  await setup.waitForFrame((frame) => frame.includes("ax"), { maxPasses: 100 })
  expect(prompt.plainText).toBe("ax")

  // Clicking the panel restores its keys; one press moves exactly one row.
  const panel = setup.renderer.root.findDescendantById("session-panel")
  if (!panel) throw new Error("missing panel")
  await setup.mockMouse.click(panel.x + 3, panel.y + 3)
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable?.id === "session-panel")
  setup.mockInput.pressArrow("down")
  await setup.waitFor(() => selectedRow(setup).includes("coder"))
  expect(prompt.plainText).toBe("ax")
})
test("typing while the panel has focus goes to the composer, digits and @ included", async () => {
  await using setup = await fixture({ width: 220, height: 45 })
  await ready(setup)
  const prompt = setup.renderer.currentFocusedEditor
  if (!(prompt instanceof TextareaRenderable)) throw new Error("missing prompt")
  await openAgents(setup)

  // The tab opens on the Trace lens.
  const entered = setup.captureCharFrame()
  expect(entered).toContain("NOW")
  expect(entered).not.toContain("All branches")

  // Every printable character reaches the composer instead of being dropped:
  // the lens never changes, and digits and @ are text like everything else.
  setup.mockInput.typeText("213")
  await setup.waitForFrame((frame) => frame.includes("213"), { maxPasses: 100 })
  expect(prompt.plainText).toBe("213")
  setup.mockInput.typeText("@coder-1 fix")
  await setup.waitForFrame((frame) => frame.includes("@coder-1 fix"), { maxPasses: 100 })
  // The mention is text for this tab's routing, never a panel command.
  expect(prompt.plainText).toContain("213@coder-1 fix")
  const typed = setup.captureCharFrame()
  expect(typed).toContain("NOW")
  expect(typed).not.toContain("All branches")

  // A paste takes the same road: it lands in the composer, not on the floor.
  const panel = setup.renderer.root.findDescendantById("session-panel")
  if (!panel) throw new Error("missing panel")
  await setup.mockMouse.click(panel.x + 3, panel.y + 3)
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable?.id === "session-panel")
  await setup.mockInput.pasteBracketedText(" pasted")
  await setup.waitForFrame((frame) => frame.includes("pasted"), { maxPasses: 100 })
  expect(prompt.plainText).toContain("pasted")

  // A key event whose base-layout key is a digit is not a digit press: the
  // kitty sequence below is `]` with no modifiers but base key "3", which is
  // the shape a ctrl+] tab switch carries. The panel must not act on it.
  setup.mockInput.pressTab()
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
  setup.renderer.stdin.emit("data", Buffer.from("\x1b[93;1;51u"))
  await setup.waitForVisualIdle({ quietFrames: 2 })
  expect(setup.captureCharFrame()).toContain("NOW")
  expect(setup.captureCharFrame()).not.toContain("All branches")
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
    const frame = setup.captureCharFrame()
    const lines = frame.split("\n")
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(width)
    // The footer under the composer is the host's status row: location and the
    // one key hint every tab shows, with no panel key list of its own.
    const footer = lines.findIndex((line) => line.includes("Git:"))
    expect(footer).toBeGreaterThan(-1)
    expect(lines[footer]).not.toContain("w next")
    expect(lines[footer]).not.toContain("? keys")
    if (width >= 120) expect(lines[footer]).toContain("^p cmd")
    expect(footer).toBeGreaterThan(prompt.y + prompt.height)
    expect(prompt.y + prompt.height).toBeLessThanOrEqual(height)
    expect(frame.toLowerCase()).toContain("banyancode")
    expect(frame.includes("BRANCHES") || frame.includes("BRCH")).toBe(true)
  }
})
test("no removed single-key action fires any more", async () => {
  await using setup = await fixture({ width: 220, height: 45 })
  await ready(setup)
  const prompt = setup.renderer.currentFocusedEditor
  if (!(prompt instanceof TextareaRenderable)) throw new Error("missing prompt")
  await openAgents(setup)

  for (const key of ["z", "f", "i", "w", "b", "s", "x", "a", "d", "l", "1", "2", "3", "[", "]"]) {
    setup.mockInput.pressKey(key)
    await setup.waitForVisualIdle({ quietFrames: 1 })
  }

  const frame = setup.captureCharFrame()
  // Still the Trace lens: the digits no longer switch it.
  expect(frame).toContain("NOW")
  expect(frame).not.toContain("All branches")
  // No armed kill, no keyboard cheat sheet; the roster is still unfolded
  // (its control says `show done`, not `show`).
  expect(frame).toContain("show done")
  expect(frame).not.toContain("confirm kill")
  expect(frame).not.toContain("move selection")
  // The characters are text, not commands.
  expect(prompt.plainText.length).toBeGreaterThan(0)
  expect(prompt.plainText).toContain("z")
})

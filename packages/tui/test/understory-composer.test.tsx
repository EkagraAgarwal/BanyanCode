import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import type { SessionInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

const NOW = Date.now()

/** Root plus two same-named branches, so the roster labels them coder-1 and coder-2. */
function fixtureSessions() {
  const token = crypto.randomUUID()
  const root: SessionInfo = {
    id: `ses_composer_root_${token}`,
    title: "Composer fixture",
    projectID: "proj_composer",
    location: { directory },
    agent: "build",
    model: { providerID: "fixture", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: NOW - 10_000, updated: NOW, busy: NOW - 10_000, idle: NOW - 1_000 },
  }
  const branch = (agent: string, title: string, created: number): SessionInfo => ({
    id: `ses_composer_${agent}_${created}_${token}`,
    parentID: root.id,
    title,
    projectID: root.projectID,
    location: { directory },
    agent,
    model: { providerID: "fixture", id: "model" },
    cost: 0,
    tokens: { input: 4_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    // No `idle` mark and no completed message: the branch is quiet but not finished,
    // which is what makes it steerable.
    time: { created, updated: NOW - 2_000 },
  })
  // coder-1 is the older branch, as the roster numbers same-named agents by spawn order.
  const coder1 = branch("coder", "Rewrite the fallback", NOW - 9_500)
  const coder2 = branch("coder", "Check the registry", NOW - 9_000)
  return { root, coder1, coder2 }
}

async function fixture(input: { readonly width: number; readonly height: number }) {
  const { root, coder1, coder2 } = fixtureSessions()
  const steers: Array<Record<string, unknown>> = []
  const prompts: string[] = []
  const messages = (sessionID: string) => [
    { id: `${sessionID}_user`, type: "user", text: "a prompt", time: { created: NOW - 8_000 } },
  ]
  const setup = await createAppFixture({
    width: input.width,
    height: input.height,
    args: { sessionID: root.id },
    config: { animations: false, tabs: { mode: "on" }, session: { sidebar: "hide" } },
    fetch: async (url, request) => {
      if (url.pathname.startsWith("/api/rpc/banyancode.mesh/") && url.pathname.endsWith("/steer")) {
        const body = await request.json().catch(() => ({}))
        steers.push((body as { input?: Record<string, unknown> }).input ?? {})
        return json({ output: { delivered: 1 } })
      }
      if (url.pathname === "/api/location")
        return json({ directory, project: { id: root.projectID, directory, canonical: directory } })
      if (url.pathname === "/api/agent")
        return json({
          location: { directory },
          data: [
            { id: "build", mode: "primary", hidden: false, permissions: [] },
            { id: "coder", mode: "subagent", hidden: false, permissions: [] },
          ],
        })
      if (url.pathname === "/api/model")
        return json({
          location: { directory },
          data: [{ id: "model", providerID: "fixture", name: "Model", variants: [] }],
        })
      if (url.pathname === "/api/provider") return json({ location: { directory }, data: [{ id: "fixture", name: "Fixture" }] })
      if (url.pathname === "/api/vcs")
        return json({ location: { directory }, data: { branch: { current: "dev", default: "dev" } } })
      if (url.pathname === "/api/fs/find" || url.pathname === "/api/fs/list")
        return json({ location: { directory }, data: [] })
      if (url.pathname === "/api/session") return json({ data: [root, coder1, coder2], cursor: {} })
      if (url.pathname === `/api/session/${root.id}`) return json({ data: root })
      if (url.pathname === `/api/session/${coder1.id}`) return json({ data: coder1 })
      if (url.pathname === `/api/session/${coder2.id}`) return json({ data: coder2 })
      if (url.pathname.endsWith("/message")) {
        const id = url.pathname.split("/")[3] ?? ""
        return json({ data: messages(id), cursor: {} })
      }
      if (url.pathname.endsWith("/inbox")) return json({ data: [] })
      if (url.pathname.endsWith("/permission")) return json({ data: [] })
      if (url.pathname.endsWith("/form")) return json({ data: [] })
      if (url.pathname.endsWith("/view")) return json({ data: {} })
      if (url.pathname.endsWith("/prompt")) {
        const body = await request.json().catch(() => ({}))
        prompts.push(JSON.stringify(body))
        return json({ data: {} })
      }
      if (url.pathname === "/api/rpc/banyancode.mesh/steer") return json({ output: { delivered: 1 } })
      if (url.pathname === "/api/rpc/banyancode.mesh/steer") return json({ output: { delivered: 1 } })
      if (url.pathname.includes("/rpc/banyancode.mesh/")) {
        // Every other mesh call answers as the unbuilt namespace does.
        return json({ _tag: "RpcNotFoundError", type: "rpc.method_not_found", message: "not available" }, { status: 404 })
      }
      return undefined
    },
  })
  return { ...setup, root, coder1, coder2, steers, prompts }
}

async function ready(setup: Awaited<ReturnType<typeof fixture>>) {
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("a prompt"), { maxPasses: 300 })
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
}

async function openAgents(setup: Awaited<ReturnType<typeof fixture>>) {
  setup.mockInput.pressKey("]", { ctrl: true })
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable?.id === "session-panel")
  setup.mockInput.pressKey("]", { ctrl: true })
  await setup.waitForFrame(
    (frame) => frame.includes("1 Trace") && (frame.includes("BRANCHES") || frame.includes("BRCH")),
    { maxPasses: 300 },
  )
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable?.id === "session-panel")
}

test("the Agents tab routes @branch through the composer and Chat keeps the plain one", async () => {
  await using setup = await fixture({ width: 200, height: 45 })
  await ready(setup)
  /** The composer that has focus now; the session route may remount it with the tab. */
  const editor = () => {
    const current = setup.renderer.currentFocusedEditor
    if (!(current instanceof TextareaRenderable)) throw new Error("missing prompt")
    return current
  }

  // Chat first: no tab labels, and plain text reaches the root agent.
  const chat = setup.captureCharFrame()
  expect(chat).not.toContain("→ build")
  expect(chat).not.toContain("Message build, or @ to steer one branch")
  setup.mockInput.typeText("just chat")
  await setup.waitFor(() => editor().plainText === "just chat")
  setup.mockInput.pressEnter()
  await setup.waitFor(() => setup.prompts.length === 1, { maxPasses: 300 })
  await setup.waitFor(() => editor().plainText === "")

  await openAgents(setup)

  // The tab names the destination on the model row and its own placeholder.
  await setup.waitForFrame((frame) => frame.includes("Message build, or @ to steer one branch"), { maxPasses: 200 })
  expect(setup.captureCharFrame()).toContain("→ build")

  // `@` on the tab focuses the composer with the `@` already typed and opens
  // the branch picker, listed by roster label.
  setup.mockInput.typeText("@")
  await setup.waitForFrame((frame) => frame.includes("coder-1") && frame.includes("coder-2"), { maxPasses: 300 })
  await setup.waitFor(() => editor().plainText === "@")

  // Enter accepts the first row: plain text, not an agent mention.
  setup.mockInput.pressEnter()
  await setup.waitFor(() => editor().plainText === "@coder-1 ")
  await setup.waitForFrame((frame) => frame.includes("→ coder-1"), { maxPasses: 200 })

  // The send steers that one session, not every coder.
  await setup.mockInput.typeText("please continue")
  await setup.waitFor(() => editor().plainText === "@coder-1 please continue")
  setup.mockInput.pressEnter()
  await setup.waitFor(() => setup.steers.length === 1, { maxPasses: 300 })
  expect(setup.steers[0]).toEqual({
    parentSessionID: setup.root.id,
    targetAgent: "coder",
    targetSessionID: setup.coder1.id,
    instruction: "please continue",
  })
  await setup.waitForFrame((frame) => frame.includes("Steered coder-1"), { maxPasses: 300 })
  // A claimed send clears the composer and never reaches the root agent.
  await setup.waitFor(() => editor().plainText === "")
  expect(setup.prompts).toHaveLength(1)

  // Leaving the tab restores the plain composer: no route label, no tab placeholder.
  setup.mockInput.pressEscape()
  await setup.waitFor(() => setup.renderer.root.findDescendantById("session-panel") === undefined)
  await setup.waitForFrame((frame) => !frame.includes("1 Trace"), { maxPasses: 200 })
  const back = setup.captureCharFrame()
  expect(back).not.toContain("→ coder-1")
  expect(back).not.toContain("Message build, or @ to steer one branch")
  expect(setup.steers).toHaveLength(1)
})

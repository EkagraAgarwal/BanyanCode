import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { createAppFixture } from "./fixture/app"

const location = { directory, project: { id: "project", directory, canonical: directory } }

function agent(id: string) {
  return { id, mode: "primary", hidden: false, permissions: [] }
}

const models = ["first", "second"].map((id) => ({
  id,
  providerID: "demo",
  name: `${id} model`,
  variants: [],
  cost: [],
  time: { released: 0 },
}))

function fixtureFetch(input: {
  agents: ReturnType<typeof agent>[]
  session?: boolean
  sessionAgent?: string
  mutations?: Record<string, unknown>[]
}) {
  const sessionID = "ses_mode_toggle"
  return async (url: URL, request: Request) => {
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/agent") return json({ location, data: input.agents })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
    if (url.pathname === "/api/model") return json({ location, data: models })
    if (url.pathname === "/api/command")
      return json({ location, data: [{ name: "review", description: "Review the input" }] })
    if (!input.session) return
    if (url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "project",
          title: "Mode toggle fixture",
          agent: input.sessionAgent ?? "build",
          model: { providerID: "demo", id: "first" },
          location: { directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    if (/^\/api\/session\/[^/]+\/(message|inbox|permission|form)$/.test(url.pathname))
      return json({ data: [], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/agent`) {
      input.mutations?.push({ type: "agent", body: await request.json() })
      return new Response(null, { status: 204 })
    }
    if (url.pathname === `/api/session/${sessionID}/model`) {
      input.mutations?.push({ type: "model", body: await request.json() })
      return new Response(null, { status: 204 })
    }
  }
}

async function prompt(setup: Awaited<ReturnType<typeof createAppFixture>>) {
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const editor = setup.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("missing prompt")
  return editor
}

test("tab toggles build and plan from home without typing a tab character", async () => {
  await using state = await tmpdir()
  await using setup = await createAppFixture({
    state: state.path,
    width: 140,
    height: 30,
    config: { animations: false },
    fetch: fixtureFetch({ agents: [agent("build"), agent("plan")] }),
  })
  {
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Build · first model"))
    const editor = await prompt(setup)
    expect(setup.captureCharFrame()).toContain("tab plan")

    setup.mockInput.typeText("hi")
    await setup.waitFor(() => editor.plainText === "hi")

    setup.mockInput.pressTab()
    await setup.waitForFrame((frame) => frame.includes("Plan · first model"))
    expect(editor.plainText).toBe("hi")
    expect(setup.captureCharFrame()).toContain("tab build")

    setup.mockInput.pressTab()
    await setup.waitForFrame((frame) => frame.includes("Build · first model"))
    expect(editor.plainText).toBe("hi")
    expect(editor.plainText).not.toContain("\t")
  }
})

test("tab from orchestrator enters plan mode", async () => {
  await using state = await tmpdir()
  const sessionID = "ses_mode_toggle"
  await using setup = await createAppFixture({
    state: state.path,
    width: 140,
    height: 30,
    config: { animations: false },
    args: { sessionID },
    fetch: fixtureFetch({
      agents: [agent("build"), agent("plan"), agent("orchestrator")],
      session: true,
      sessionAgent: "orchestrator",
    }),
  })
  {
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Orchestrator · first model"))
    setup.mockInput.pressTab()
    await setup.waitForFrame((frame) => frame.includes("Plan · first model"))
    expect(setup.captureCharFrame()).toContain("tab build")
  }
})

test("an open autocomplete keeps tab and the base toggle resumes once it closes", async () => {
  await using state = await tmpdir()
  await using setup = await createAppFixture({
    state: state.path,
    width: 140,
    height: 30,
    config: { animations: false },
    fetch: fixtureFetch({ agents: [agent("build"), agent("plan")] }),
  })
  {
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Build · first model"))
    const editor = await prompt(setup)

    setup.mockInput.typeText("/review")
    await setup.waitForFrame((frame) => frame.includes("Review the input"))
    setup.mockInput.pressTab()
    await setup.waitFor(() => editor.plainText === "/review ")
    await setup.waitForFrame((frame) => frame.includes("Build · first model"))
    expect(setup.captureCharFrame()).not.toContain("Plan · first model")
    expect(editor.plainText).not.toContain("\t")

    setup.mockInput.pressTab()
    await setup.waitForFrame((frame) => frame.includes("Plan · first model"))
    expect(editor.plainText).toBe("/review ")
  }
})

test("tab is a no-op when plan is unavailable", async () => {
  await using state = await tmpdir()
  await using setup = await createAppFixture({
    state: state.path,
    width: 140,
    height: 30,
    config: { animations: false },
    fetch: fixtureFetch({ agents: [agent("build")] }),
  })
  {
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Build · first model"))
    const editor = await prompt(setup)
    setup.mockInput.pressTab()
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Build · first model")
    expect(setup.captureCharFrame()).not.toContain("tab plan")
    expect(editor.plainText).toBe("")
  }
})

test("a focused dialog keeps tab", async () => {
  await using state = await tmpdir()
  await using setup = await createAppFixture({
    state: state.path,
    width: 140,
    height: 30,
    config: { animations: false },
    fetch: fixtureFetch({ agents: [agent("build"), agent("plan")] }),
  })
  {
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Build · first model"))
    setup.mockInput.pressKey("p", { ctrl: true })
    await setup.waitForFrame((frame) => frame.includes("Commands"))
    setup.mockInput.pressTab()
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => frame.includes("Build · first model"))
    expect(setup.captureCharFrame()).not.toContain("Plan · first model")
  }
})

test("tab in an existing session keeps its draft and commits plan on submit", async () => {
  await using state = await tmpdir()
  const mutations: Record<string, unknown>[] = []
  const sessionID = "ses_mode_toggle"
  await using setup = await createAppFixture({
    state: state.path,
    width: 100,
    height: 30,
    config: { animations: false },
    args: { sessionID },
    fetch: fixtureFetch({ agents: [agent("build"), agent("plan")], session: true, mutations }),
  })
  {
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Build · first model"))
    setup.mockInput.pressTab()
    await setup.waitForFrame((frame) => frame.includes("Plan · first model"))

    setup.mockInput.pressEnter()
    await setup.waitFor(() => mutations.length > 0)
    expect(mutations[0]).toEqual({ type: "agent", body: { agent: "plan" } })
  }
})

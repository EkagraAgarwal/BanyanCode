/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import InspectorAgentDetails from "../../../src/feature-plugins/inspector/agent-details"
import { SyncContext } from "../../../src/context/sync"
import { stateApi } from "../../../src/plugin/adapters"
import { createTuiPluginApi } from "../../fixture/tui-plugin"

const stubTheme = {
  text: { r: 200, g: 200, b: 200, a: 1 },
  textMuted: { r: 120, g: 120, b: 120, a: 1 },
  primary: { r: 100, g: 200, b: 100, a: 1 },
  secondary: { r: 100, g: 100, b: 200, a: 1 },
  success: { r: 100, g: 200, b: 100, a: 1 },
  error: { r: 200, g: 100, b: 100, a: 1 },
  warning: { r: 200, g: 200, b: 100, a: 1 },
  accent: { r: 150, g: 150, b: 150, a: 1 },
  info: { r: 100, g: 100, b: 100, a: 1 },
}

type LspFixture = {
  id: string
  name: string
  root: string
  status: "configured" | "connected" | "error"
  autoDownload: boolean
  languages: Array<string>
  inert: boolean
  disabled: boolean
  disabledReason?: string
}

const populatedLsp: Array<LspFixture> = [
  {
    id: "typescript",
    name: "typescript",
    root: "/tmp/project",
    status: "connected",
    autoDownload: false,
    languages: ["TypeScript", "JavaScript"],
    inert: false,
    disabled: false,
  },
  {
    id: "gopls",
    name: "gopls",
    root: "",
    status: "configured",
    autoDownload: false,
    languages: ["Go"],
    inert: true,
    disabled: false,
  },
  {
    id: "ruby-lsp",
    name: "ruby-lsp",
    root: "",
    status: "configured",
    autoDownload: false,
    languages: ["Ruby"],
    inert: true,
    disabled: true,
    disabledReason: "disabled in banyancode.json",
  },
  {
    id: "eslint-error",
    name: "eslint-error",
    root: "/tmp/project",
    status: "error",
    autoDownload: false,
    languages: ["JavaScript"],
    inert: false,
    disabled: false,
  },
]

function makeSync(lsp: Array<LspFixture>, banyancodeLsp: true | undefined) {
  const session = {
    id: "session_test",
    title: "Inspector LSP regression",
    agent: "coder",
    model: { id: "test/model" },
    time: { created: Date.parse("2026-07-23T12:00:00Z") },
  }
  const message = {
    id: "message_test",
    role: "assistant",
    cost: 0.25,
    tokens: { input: 100, output: 25, reasoning: 5 },
    time: { completed: Date.now() - 6 * 60 * 1000 },
  }
  return {
    ready: true,
    data: {
      config: {},
      provider: [],
      session: [session],
      session_status: { session_test: { type: "idle" } },
      session_diff: {},
      todo: {},
      permission: {},
      question: {},
      message: { session_test: [message] },
      part: { message_test: [{ id: "part_test", type: "tool", tool: "read" }] },
      lsp,
      mcp: {},
      banyanConfig: { banyancode_lsp: banyancodeLsp },
    },
    path: { home: "", state: "", config: "", worktree: "", directory: "" },
    session: { get: () => session },
  }
}

async function renderAgentDetails(lsp: Array<LspFixture>, banyancodeLsp: true | undefined) {
  const sync = makeSync(lsp, banyancodeLsp)

  function Inner() {
    let slot: any
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      state: {
        ...stateApi(sync as any),
        banyanConfig: { banyancode_lsp: banyancodeLsp },
      },
      slots: {
        register(plugin: any) {
          slot = plugin.slots.session_inspector
          return () => {}
        },
      },
    }
    void InspectorAgentDetails.tui(api, undefined as any, { id: "test" } as any)
    return <box flexDirection="column">{slot({}, { session_id: "session_test" })}</box>
  }

  const setup = await testRender(
    () => (
      <SyncContext.Provider value={sync as any}>
        <Inner />
      </SyncContext.Provider>
    ),
    { width: 60, height: 50 },
  )

  try {
    await setup.renderOnce()
    return setup
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd()
  } finally {
    setup.renderer.destroy()
  }
}

test("inspector agent-details renders only connected, enabled LSPs", async () => {
  const frame = await renderAgentDetails(populatedLsp, true)

  expect(frame).toContain("typescript")
  expect(frame).not.toContain("gopls")
  expect(frame).not.toContain("ruby-lsp")
  expect(frame).not.toContain("eslint-error")
  expect(frame).toContain("Task: Inspector LSP regression")
  expect(frame).toContain("Model: model ▾")
  expect(frame).toMatch(/Last: \d+[smh] ago/)
  expect(frame).not.toContain("Task:Inspector")
  expect(frame).not.toContain("Last:6m ago")
  expect(
    frame.replace(/Started: \d{2}:\d{2}:\d{2}/, "Started: <time>").replace(/Last: \d+[smh] ago/, "Last: <elapsed>"),
  ).toMatchSnapshot()
})

test("inspector agent-details shows the empty LSP note when no active server is connected", async () => {
  const frame = await renderAgentDetails(populatedLsp.filter((entry) => entry.status !== "connected"), true)

  expect(frame).toContain("No active LSPs yet")
  expect(frame).not.toContain("gopls")
  expect(frame).not.toContain("ruby-lsp")
  expect(frame).not.toContain("eslint-error")
})

test("inspector agent-details shows the disabled fallback when banyancode_lsp is falsy", async () => {
  const frame = await renderAgentDetails([], undefined)

  expect(frame).toContain("Disabled. Run /lsp or set banyancode_lsp: true")
})

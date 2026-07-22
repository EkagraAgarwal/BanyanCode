/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import SidebarContext from "../../../src/feature-plugins/sidebar/context"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import { SyncProvider } from "../../../src/context/sync"
import { ProjectProvider } from "../../../src/context/project"
import { ExitProvider } from "../../../src/context/exit"
import { ArgsProvider } from "../../../src/context/args"

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

const fixtureUser = {
  id: "msg-u1",
  type: "user" as const,
  role: "user" as const,
  text: "this is a user prompt",
  time: { created: 0 },
}

const fixtureAssistant = {
  id: "msg-1",
  type: "assistant" as const,
  role: "assistant" as const,
  content: [
    {
      type: "tool" as const,
      tool: "read",
      state: {
        status: "completed",
        output: "file content here",
        content: [{ type: "text" as const, text: "file content here" }],
      },
    },
    {
      type: "tool" as const,
      tool: "mesh_control",
      state: {
        status: "completed",
        input: { action: "planFor", target: "explore", plan: { title: "Investigate" } },
        content: [{ type: "text" as const, text: "ok" }],
      },
    },
  ],
  tokens: { input: 5000, output: 3000, reasoning: 1000, cache: { read: 0, write: 0 } },
  modelID: "test-model",
  providerID: "test-provider",
  time: { created: 0, completed: 1000 },
}

test("sidebar context sidebar_content slot renders with categorized tokens", async () => {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  const [slotContent, setSlotContent] = createSignal<any>(null)
  const [rendered, setRendered] = createSignal<string>("")

  function Inner() {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      state: {
        session: {
          get: () => undefined,
          messages: (sessionID: string) => [fixtureAssistant, fixtureUser],
        },
        provider: { find: () => ({ models: { "test-model": { limit: { context: 100000 } } } }) },
        path: { directory: "/test/workspace" },
        mcp: () => [],
        lsp: () => [],
      },
    }
    api.slots = {
      register: (plugin: any) => {
        if (!plugin?.slots?.sidebar_content) return () => {}
        const el = plugin.slots.sidebar_content({}, { session_id: "session_test" })
        setSlotContent(() => el)
        return () => {}
      },
    }
    onMount(() => {
      SidebarContext.tui(api as any, undefined as any, { id: "test" } as any).catch(() => {})
    })
    return <box>{slotContent()}</box>
  }

  const testSetup = await testRender(() => (
    <ExitProvider exit={console.error}>
      <TestTuiContexts>
        <ArgsProvider>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
              <ProjectProvider>
                <SyncProvider>
                  <TuiConfigProvider config={config}>
                    <ThemeProvider mode="dark">
                      <Inner />
                    </ThemeProvider>
                  </TuiConfigProvider>
                </SyncProvider>
              </ProjectProvider>
            </SDKProvider>
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    </ExitProvider>
  ), { width: 80, height: 40 })
  await testSetup.renderOnce()
  await new Promise((r) => setTimeout(r, 0))
  await testSetup.renderOnce()
  setRendered(
    testSetup
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd(),
  )
  try {
    expect(rendered()).toMatchSnapshot()
  } finally {
    testSetup.renderer.destroy()
  }
})

test("context widget source contains concise single-line category labels", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/context.tsx"),
    "utf8",
  )
  for (const label of ["User", "Subagents", "Agent", "Tools", "Files", "Prompt", "Thinking"]) {
    expect(source).toContain(label)
  }
})

test("context widget no longer uses the old 'Memory' label", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/context.tsx"),
    "utf8",
  )
  expect(source).not.toMatch(/label:\s*"Memory"/)
})

test("context widget filters zero-token categories for compact display", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/context.tsx"),
    "utf8",
  )
  // To keep the sidebar compact as requested, zero-token categories are hidden.
  const usedIdx = source.indexOf("Used {formatTokensCompact(tb().total)}")
  expect(usedIdx).toBeGreaterThan(-1)
  const afterUsed = source.slice(usedIdx)
  expect(afterUsed).toMatch(/filter\(\(s\)\s*=>\s*s\.tokens\s*>\s*0\)/)
})

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import SidebarAgents from "../../../src/feature-plugins/sidebar/agents"
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

const fixtureMeshStatus = {
  parentSessionID: "session_test",
  peers: [
    {
      sessionID: "peer-1",
      agent: "Explore",
      status: "active" as const,
      lastSeenAt: Date.now(),
      cost: 0.015,
      tokens: { input: 500, output: 1000, reasoning: 200, cache: { read: 0, write: 0 } },
    },
    {
      sessionID: "peer-2",
      agent: "Coder",
      status: "idle" as const,
      lastSeenAt: Date.now() - 5000,
      cost: 0.008,
      tokens: { input: 300, output: 600, reasoning: 100, cache: { read: 0, write: 0 } },
    },
  ],
  pendingMessages: 2,
  recentActivity: [],
}

test("sidebar agents sidebar_content slot renders with mesh peers", async () => {
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session/mesh") {
      return new Response(JSON.stringify({ data: fixtureMeshStatus }), {
        headers: { "content-type": "application/json" },
      })
    }
    return undefined
  })
  const config = createTuiResolvedConfig()
  const [slotContent, setSlotContent] = createSignal<any>(null)

  function Inner() {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      client: {
        global: { banyanConfig: { get: async () => ({ data: { banyancode_max_subagents: 5 } }) } },
        session: { mesh: async (args: any) => ({ data: fixtureMeshStatus }) },
      },
      state: {
        session: { get: () => undefined },
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
      SidebarAgents.tui(api as any, undefined as any, { id: "test" } as any).catch(() => {})
      queueMicrotask(() => {
        events.emit({
          directory,
          payload: {
            id: "evt_mesh_status",
            type: "banyancode.mesh.status",
            properties: fixtureMeshStatus,
          } as any,
        })
      })
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
  ), { width: 40, height: 50 })
  await testSetup.renderOnce()
  await new Promise((r) => setTimeout(r, 0))
  await testSetup.renderOnce()
  const snapshot = testSetup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
  try {
    expect(snapshot).toMatchSnapshot()
  } finally {
    testSetup.renderer.destroy()
  }
})

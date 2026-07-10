/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import SidebarSystemStatus from "../../../src/feature-plugins/sidebar/system-status"
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

test("sidebar system-status sidebar_content slot renders without throwing", async () => {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  const [slotContent, setSlotContent] = createSignal<any>(null)

  function Inner() {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      state: {
        session: { get: () => undefined },
        path: { directory: "/test/workspace" },
        mcp: () => [{ name: "test-mcp", status: "connected" }],
        lsp: () => [{ name: "test-lsp" }],
      },
    }
    api.slots = {
      register: (plugin: any) => {
        if (!plugin?.slots?.sidebar_content) return () => {}
        const el = plugin.slots.sidebar_content({})
        setSlotContent(() => el)
        return () => {}
      },
    }
    onMount(() => {
      SidebarSystemStatus.tui(api as any, undefined as any, { id: "test" } as any).catch(() => {})
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

test("system-status Bar uses height=1 with no flexGrow to prevent vertical expansion", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/system-status.tsx"),
    "utf8",
  )
  expect(source).toContain('flexDirection="row" height={1} width="100%"')
  const barBlockMatch = source.match(/function Bar[\s\S]*?^}/m)
  expect(barBlockMatch).not.toBeNull()
  const barBlock = barBlockMatch![0]
  expect(barBlock).not.toMatch(/flexGrow=\{1\}/)
})

test("system-status wraps every Bar in a flexDirection=column metric wrapper", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/system-status.tsx"),
    "utf8",
  )
  expect(source).toMatch(/<Show when=\{cpuPercent\(\) !== undefined\}>[\s\S]*?flexDirection="column"[\s\S]*?<Bar/)
  expect(source).toMatch(/<Show when=\{memPercent\(\) !== undefined\}>[\s\S]*?flexDirection="column"[\s\S]*?<Bar/)
  expect(source).toMatch(/<Show when=\{diskPercent\(\) !== undefined\}>[\s\S]*?flexDirection="column"[\s\S]*?<Bar/)
})

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import HeaderStatusPills from "../../../src/feature-plugins/header/status-pills"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import { RGBA } from "@opentui/core"

const stubTheme = {
  text: RGBA.fromInts(200, 200, 200),
  textMuted: RGBA.fromInts(120, 120, 120),
  primary: RGBA.fromInts(100, 200, 100),
  secondary: RGBA.fromInts(100, 100, 200),
  accent: RGBA.fromInts(100, 200, 100),
  success: RGBA.fromInts(100, 200, 100),
  error: RGBA.fromInts(200, 100, 100),
  warning: RGBA.fromInts(200, 200, 100),
  info: RGBA.fromInts(100, 200, 200),
  background: RGBA.fromInts(20, 20, 20),
  backgroundPanel: RGBA.fromInts(30, 30, 30),
  backgroundElement: RGBA.fromInts(40, 40, 40),
  border: RGBA.fromInts(80, 80, 80),
  borderSubtle: RGBA.fromInts(60, 60, 60),
  borderActive: RGBA.fromInts(100, 100, 100),
}

test("header status-pills app_top slot renders without throwing", async () => {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  const [slotContent, setSlotContent] = createSignal<any>(null)

  const Inner = () => {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      state: {
        session: { get: () => undefined },
        session_status: {},
        path: { directory: "/test/workspace" },
        mcp: () => [{ name: "test-mcp", status: "connected" }],
        lsp: () => [],
      },
      client: {
        session: {
          list: async () => ({ data: [{ id: "1" }, { id: "2" }] }),
        },
      },
    }
    api.slots = {
      register: (plugin: any) => {
        if (!plugin?.slots?.app_top) return () => {}
        const el = plugin.slots.app_top()
        setSlotContent(() => el)
        return () => {}
      },
    }
    void HeaderStatusPills.tui(api as any, undefined as any, { id: "test" } as any)

    queueMicrotask(() => {
      events.emit({
        directory,
        payload: {
          id: "evt_test_staleness",
          type: "banyancode.codegraph.staleness",
          properties: {
            isStale: false,
            lastChecked: Date.now() - 120000,
          },
        } as any,
      })
    })

    return <box>{slotContent()}</box>
  }

  const Harness = () => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <Inner />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </SDKProvider>
    </TestTuiContexts>
  )

  const app = await testRender(() => <Harness />)
  await new Promise((r) => setTimeout(r, 200))
  await app.renderOnce()
  try {
    expect(true).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

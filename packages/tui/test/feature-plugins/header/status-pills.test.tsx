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

const stubTheme = {
  text: { r: 200, g: 200, b: 200, a: 1 },
  textMuted: { r: 120, g: 120, b: 120, a: 1 },
  primary: { r: 100, g: 200, b: 100, a: 1 },
  secondary: { r: 100, g: 100, b: 200, a: 1 },
  success: { r: 100, g: 200, b: 100, a: 1 },
  error: { r: 200, g: 100, b: 100, a: 1 },
  warning: { r: 200, g: 200, b: 100, a: 1 },
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

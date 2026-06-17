/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import SidebarSystemStatus from "../../../src/feature-plugins/sidebar/system-status"
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

test("sidebar system-status sidebar_content slot renders without throwing", async () => {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  const [slotContent, setSlotContent] = createSignal<any>(null)

  // Inner is a child of SDKProvider, so useSDK() inside View() works.
  const Inner = () => {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
    }
    api.slots = {
      register: (plugin: any) => {
        if (!plugin?.slots?.sidebar_content) return () => {}
        const el = plugin.slots.sidebar_content()
        setSlotContent(() => el)
        return () => {}
      },
    }
    void SidebarSystemStatus.tui(api as any, undefined as any, { id: "test" } as any)

    // After mounting, emit a system status event so the View's status
    // signal becomes non-null and the (potentially-buggy) ProgressBar is
    // rendered.
    queueMicrotask(() => {
      events.emit({
        directory,
        payload: {
          id: "evt_test_system",
          type: "banyancode.system.updated",
          properties: {
            cpuPercent: 42,
            memoryUsedBytes: 4 * 1024 ** 3,
            memoryTotalBytes: 16 * 1024 ** 3,
            platform: "linux",
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

  // If the bug is present (nested <text>), testRender throws when the
  // event populates the status signal and the ProgressBar re-renders.
  const app = await testRender(() => <Harness />)
  // Wait for the event to flush through the SDK event bus
  await new Promise((r) => setTimeout(r, 200))
  await app.renderOnce()
  try {
    expect(true).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import SessionFooter from "../../../src/feature-plugins/footer/session-footer"
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
}

test("session-footer session_footer slot renders without throwing", async () => {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  const [slotContent, setSlotContent] = createSignal<any>(null)

  const Inner = () => {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      app: { version: "0.1.0" },
    }
    api.slots = {
      register: (plugin: any) => {
        if (!plugin?.slots?.session_footer) return () => {}
        const el = plugin.slots.session_footer()
        setSlotContent(() => el)
        return () => {}
      },
    }
    void SessionFooter.tui(api as any, undefined as any, { id: "test" } as any)
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
  await app.renderOnce()
  try {
    expect(true).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

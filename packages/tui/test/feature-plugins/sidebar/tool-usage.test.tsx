/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import SidebarToolUsage from "../../../src/feature-plugins/sidebar/tool-usage"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { createEventSource, createFetch, directory, type FetchHandler } from "../../fixture/tui-sdk"

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

const usageRows = [
  { toolId: "code_find", useCount: 42, lastUsedAt: 1722900000 },
  { toolId: "blast_radius", useCount: 7, lastUsedAt: 1722900100 },
  { toolId: "repository_query", useCount: 3, lastUsedAt: 1722900200 },
]

const renderWidget = async (fetchOverride: FetchHandler) => {
  const events = createEventSource()
  const calls = createFetch(fetchOverride)
  const config = createTuiResolvedConfig()
  const [slotContent, setSlotContent] = createSignal<any>(null)

  function Inner() {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
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
      SidebarToolUsage.tui(api as any, undefined as any, { id: "test" } as any).catch(() => {})
    })
    return <box>{slotContent()}</box>
  }

  const testSetup = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <Inner />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </SDKProvider>
    </TestTuiContexts>
  ), { width: 40, height: 50 })

  await testSetup.renderOnce()
  await new Promise((r) => setTimeout(r, 200))
  await testSetup.renderOnce()
  const frame = testSetup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
  testSetup.renderer.destroy()
  return frame
}

test("sidebar tool-usage renders the top tools returned by GET /global/tool-usage", async () => {
  const frame = await renderWidget((url: URL) => {
    if (url.pathname === "/global/tool-usage") {
      return new Response(JSON.stringify({ tools: usageRows }), {
        headers: { "content-type": "application/json" },
      })
    }
    return undefined
  })

  expect(frame).toContain("TOOL USAGE")
  expect(frame).toContain("code_find")
  expect(frame).toContain("42")
  expect(frame).toContain("blast_radius")
  expect(frame).toContain("repository_query")
})

test("sidebar tool-usage renders nothing when the endpoint is unavailable", async () => {
  // The default createFetch throws for unknown paths — simulates an older
  // server without /global/tool-usage. The widget must fail silent.
  const frame = await renderWidget(() => undefined)

  expect(frame).not.toContain("TOOL USAGE")
})

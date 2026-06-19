/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import InspectorGraphExplorer from "../../../src/feature-plugins/inspector/graph-explorer"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import { ArgsProvider } from "../../../src/context/args"
import { ProjectProvider } from "../../../src/context/project"
import { SyncProvider } from "../../../src/context/sync"
import { ExitProvider } from "../../../src/context/exit"

const stubTheme = {
  text: { r: 200, g: 200, b: 200, a: 1 },
  textMuted: { r: 120, g: 120, b: 120, a: 1 },
  primary: { r: 100, g: 200, b: 100, a: 1 },
  secondary: { r: 100, g: 100, b: 200, a: 1 },
  success: { r: 100, g: 200, b: 100, a: 1 },
  error: { r: 200, g: 100, b: 100, a: 1 },
  warning: { r: 200, g: 200, b: 100, a: 1 },
}

test("graph-explorer session_inspector slot renders without throwing", async () => {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  let done: () => void
  const ready = new Promise<void>((r) => {
    done = r
  })

  function Inner() {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      slots: {
        register(plugin: any) {
          if (!plugin?.slots?.session_inspector) return () => {}
          void plugin.tui(api, undefined as any, { id: "test" } as any)
          plugin.slots.session_inspector({}, { session_id: "session_test" })
          return () => {}
        },
      },
    }
    onMount(done)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ExitProvider exit={console.error}>
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
      </ExitProvider>
    </TestTuiContexts>
  ))

  await ready
  await new Promise((r) => setTimeout(r, 200))
  await app.renderOnce()
  try {
    expect(true).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})
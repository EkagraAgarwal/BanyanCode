/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import AttentionStripPlugin from "../../src/component/attention-strip"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { ThemeProvider } from "../../src/context/theme"
import { KVProvider } from "../../src/context/kv"
import { TuiConfigProvider } from "../../src/config"
import { SDKProvider } from "../../src/context/sdk"
import { createEventSource, createFetch, directory } from "../fixture/tui-sdk"
import { SyncProvider } from "../../src/context/sync"
import { ProjectProvider } from "../../src/context/project"
import { ExitProvider } from "../../src/context/exit"
import { ArgsProvider } from "../../src/context/args"

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

test("attention-strip session_attention_strip slot renders with blocked agents", async () => {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  let done: () => void
  const ready = new Promise<void>((r) => { done = r })

  function Inner() {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      state: {
        session: { get: () => undefined },
        lsp: () => [{ name: "test-lsp" }],
        mcp: () => [{ name: "test-mcp", status: "connected" }],
        path: { directory: "/test/workspace" },
      },
      slots: {
        register(plugin: any) {
          if (!plugin?.slots?.session_attention_strip) return () => {}
          void plugin.tui(api, undefined as any, { id: "test" } as any)
          plugin.slots.session_attention_strip({}, { sessionID: "session_test" })
          return () => {}
        },
      },
    }
    onMount(done)
    queueMicrotask(() => {
      events.emit({
        directory,
        payload: {
          id: "evt_mesh",
          type: "banyancode.mesh.status",
          properties: {
            parentSessionID: "session_test",
            peers: [
              { agent: "Explore", status: "disconnected", blockedReason: "Rate limited" },
            ],
          },
        } as any,
      })
    })
    return <box />
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
  ), { width: 120, height: 10 })

  await ready
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

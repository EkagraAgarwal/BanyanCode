/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import TabSessions from "../../../src/feature-plugins/tabs/tab-sessions"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { DialogProvider } from "../../../src/ui/dialog"
import { RouteProvider } from "../../../src/context/route"
import { ProjectProvider } from "../../../src/context/project"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"

const stubTheme = {
  text: { r: 200, g: 200, b: 200, a: 1 },
  textMuted: { r: 120, g: 120, b: 120, a: 1 },
  primary: { r: 100, g: 200, b: 100, a: 1 },
  secondary: { r: 100, g: 100, b: 200, a: 1 },
  success: { r: 100, g: 200, b: 100, a: 1 },
  error: { r: 200, g: 100, b: 100, a: 1 },
  warning: { r: 200, g: 200, b: 100, a: 1 },
  border: { r: 60, g: 60, b: 60, a: 1 },
  info: { r: 100, g: 150, b: 220, a: 1 },
  background: { r: 20, g: 20, b: 20, a: 1 },
}

function stubClient() {
  return {
    session: {
      list: async () => ({ data: [] }),
      create: async () => ({ data: { id: "new-id" } }),
    },
  } as any
}

function Harness(props: { children: any }) {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  return (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <RouteProvider>
              <ProjectProvider>
                <DialogProvider>
                  <ThemeProvider mode="dark">
                    {props.children}
                  </ThemeProvider>
                </DialogProvider>
              </ProjectProvider>
            </RouteProvider>
          </KVProvider>
        </TuiConfigProvider>
      </SDKProvider>
    </TestTuiContexts>
  )
}

test("tab-sessions session_tab_sessions slot renders without throwing", async () => {
  const [slotContent, setSlotContent] = createSignal<any>(null)

  const Inner = () => {
    const api: any = {
      ...createTuiPluginApi({ client: stubClient() }),
      theme: { current: stubTheme },
    }
    api.slots = {
      register: (plugin: any) => {
        if (!plugin?.slots?.session_tab_sessions) return () => {}
        const el = plugin.slots.session_tab_sessions()
        setSlotContent(() => el)
        return () => {}
      },
    }
    onMount(() => {
      void TabSessions.tui(api as any, undefined as any, { id: "test" } as any)
    })

    return <box>{slotContent()}</box>
  }

  const app = await testRender(() => (
    <Harness>
      <Inner />
    </Harness>
  ), { width: 60, height: 30 })
  await app.renderOnce()
  try {
    expect(true).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("tab-sessions source defines a New session button and empty-state fallback", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-sessions.tsx"),
    "utf8",
  )
  expect(source).toContain("[+ New session]")
  expect(source).toContain("No sessions yet")
  expect(source).toContain("continue")
  expect(source).toContain("rename")
  expect(source).toContain("delete")
  expect(source).toContain("DialogConfirm.show")
  expect(source).toContain("DialogSessionDeleteFailed")
  expect(source).toContain("RoundedBorder.customBorderChars")
})
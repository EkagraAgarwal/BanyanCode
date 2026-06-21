/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { RGBA } from "@opentui/core"
import SidebarAgentTree from "../../../src/feature-plugins/sidebar/agent-tree"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { ExitProvider } from "../../../src/context/exit"
import { ArgsProvider } from "../../../src/context/args"
import { ProjectProvider } from "../../../src/context/project"
import { SyncProvider } from "../../../src/context/sync"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"

function makeColor(r: number, g: number, b: number, a = 255) {
  return RGBA.fromInts(r, g, b, a)
}

const stubTheme = {
  text: makeColor(200, 200, 200),
  textMuted: makeColor(120, 120, 120),
  primary: makeColor(100, 200, 100),
  secondary: makeColor(100, 100, 200),
  success: makeColor(100, 200, 100),
  error: makeColor(200, 100, 100),
  warning: makeColor(200, 200, 100),
}

const stubSessions = [
  { id: "current-session", parentID: undefined, title: "orchestrator" },
  { id: "child-1", parentID: "current-session", title: "researcher", summary: undefined },
  { id: "child-2", parentID: "current-session", title: "scout", summary: { additions: 5, deletions: 2, files: 3 } },
  { id: "child-3", parentID: "current-session", title: "coder", summary: undefined },
  { id: "child-4", parentID: "current-session", title: "explorer", summary: { additions: 10, deletions: 1, files: 7 } },
]

test("sidebar agent-tree sidebar_content slot renders without throwing", async () => {
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json(stubSessions)
    if (url.pathname === "/session/status") {
      const id = url.searchParams.get("sessionID")
      if (id === "child-1" || id === "child-3") return json({ [id]: { type: "busy" } })
      if (id === "child-2" || id === "child-4") return json({ [id]: { type: "idle" } })
      return json({})
    }
  })
  const config = createTuiResolvedConfig()
  const [rendered, setRendered] = createSignal(false)

  const Harness = () => {
    let slotFn: any = null
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      client: {
        session: {
          list: async () => ({ data: stubSessions }),
        },
      },
      state: {
        session: {
          get: () => undefined,
          status: (id: string) => {
            if (id === "child-1" || id === "child-3") return Promise.resolve({ type: "busy" })
            if (id === "child-2" || id === "child-4") return Promise.resolve({ type: "idle" })
            return Promise.resolve({ type: "idle" })
          },
          diff: () => [],
          todo: () => [],
          messages: () => Promise.resolve([]),
          permission: () => [],
          question: () => [],
        },
      },
    }
    api.slots = {
      register: (plugin: any) => {
        if (plugin?.slots?.sidebar_content) {
          slotFn = plugin.slots.sidebar_content
        }
        return () => {}
      },
    }
    void SidebarAgentTree.tui(api as any, undefined as any, { id: "test" } as any)
    // Signal that plugin was registered without throwing
    setRendered(true)
    return (
      <TestTuiContexts>
        <ExitProvider exit={console.error}>
          <ArgsProvider>
            <KVProvider>
              <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
                <ProjectProvider>
                  <SyncProvider>
                    <TuiConfigProvider config={config}>
                      <ThemeProvider mode="dark">
                        <box flexDirection="column">
                          {slotFn ? slotFn(undefined as any, { session_id: "current-session" }) : null}
                        </box>
                      </ThemeProvider>
                    </TuiConfigProvider>
                  </SyncProvider>
                </ProjectProvider>
              </SDKProvider>
            </KVProvider>
          </ArgsProvider>
        </ExitProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />)
  await new Promise((r) => setTimeout(r, 200))
  await app.renderOnce()
  try {
    // Main assertion: render didn't throw
    expect(rendered()).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

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

describe("header status-pills", () => {
  test("updates the graph label from build and auto-update events", async () => {
    const events = createEventSource()
    const calls = createFetch()
    const config = createTuiResolvedConfig()
    const [slotContent, setSlotContent] = createSignal<any>(null)
    let graphNodes: Array<{ id: string }> = []

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
          global: {
            codegraph: {
              nodes: async () => ({ data: { nodes: graphNodes } }),
            },
          },
        },
      }
      api.slots = {
        register: (plugin: any) => {
          if (!plugin?.slots?.app_top) return () => {}
          setSlotContent(() => plugin.slots.app_top())
          return () => {}
        },
      }
      void HeaderStatusPills.tui(api as any, undefined as any, { id: "test" } as any)

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

    const app = await testRender(() => <Harness />, { width: 100, height: 4 })
    let eventID = 0
    const emit = (type: string, properties: Record<string, unknown>) => {
      eventID += 1
      events.emit({
        directory,
        payload: {
          id: `evt_graph_status_${eventID}`,
          type,
          properties,
        } as any,
      })
    }
    const expectLabel = async (label: string) => {
      let frame = ""
      for (let i = 0; i < 50; i++) {
        await app.renderOnce()
        frame = app.captureCharFrame()
        if (frame.includes(label)) break
        await Bun.sleep(10)
      }
      expect(frame).toContain(label)
    }

    try {
      await Bun.sleep(20)
      await expectLabel("Graph: off")

      emit("banyancode.codegraph.build", { status: "running", done: 0, total: 10 })
      await expectLabel("Graph: building")

      emit("banyancode.codegraph.build", { status: "failed", done: 4, total: 10 })
      await expectLabel("Graph: build failed")

      emit("banyancode.codegraph.build", { status: "idle", done: 0, total: 0 })
      emit("banyancode.codegraph.auto-update", { status: "draining", pending: 5 })
      await expectLabel("Graph: syncing (5)")

      emit("banyancode.codegraph.auto-update", { status: "paused", pending: 0 })
      await expectLabel("Graph: paused")

      emit("banyancode.codegraph.auto-update", { status: "watching", pending: 0 })
      graphNodes = [{ id: "node_test" }]
      emit("banyancode.codegraph.build", { status: "completed", done: 10, total: 10 })
      await Bun.sleep(200)
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Graph: built")
    } finally {
      app.renderer.destroy()
    }
  })
})

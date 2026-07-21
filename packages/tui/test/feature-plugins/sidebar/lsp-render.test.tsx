/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import SidebarLsp from "../../../src/feature-plugins/sidebar/lsp"
import HeaderStatusPills from "../../../src/feature-plugins/header/status-pills"
import { stateApi } from "../../../src/plugin/adapters"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import { SyncProvider } from "../../../src/context/sync"
import { ProjectProvider } from "../../../src/context/project"
import { ExitProvider } from "../../../src/context/exit"
import { ArgsProvider } from "../../../src/context/args"
import { RGBA } from "@opentui/core"

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

const stubThemeRgba = {
  text: RGBA.fromInts(200, 200, 200),
  textMuted: RGBA.fromInts(120, 120, 120),
  primary: RGBA.fromInts(100, 200, 100),
  secondary: RGBA.fromInts(100, 100, 200),
  accent: RGBA.fromInts(100, 200, 100),
  success: RGBA.fromInts(100, 200, 100),
  error: RGBA.fromInts(200, 100, 100),
  warning: RGBA.fromInts(200, 200, 100),
  info: RGBA.fromInts(100, 100, 100),
  background: RGBA.fromInts(20, 20, 20),
  backgroundPanel: RGBA.fromInts(30, 30, 30),
  backgroundElement: RGBA.fromInts(40, 40, 40),
  border: RGBA.fromInts(80, 80, 80),
  borderSubtle: RGBA.fromInts(60, 60, 60),
  borderActive: RGBA.fromInts(100, 100, 100),
}

const populatedLsp = [
  {
    id: "typescript",
    name: "typescript",
    root: "/tmp/project",
    status: "connected",
    autoDownload: false,
    languages: ["TypeScript", "JavaScript"],
    inert: false,
    disabled: false,
  },
  {
    id: "gopls",
    name: "gopls",
    root: "",
    status: "configured",
    autoDownload: false,
    languages: ["Go"],
    inert: true,
    disabled: false,
  },
  {
    id: "rust-analyzer",
    name: "rust-analyzer",
    root: "",
    status: "configured",
    autoDownload: true,
    languages: ["Rust"],
    inert: true,
    disabled: false,
  },
  {
    id: "ruby-lsp",
    name: "ruby-lsp",
    root: "",
    status: "configured",
    autoDownload: false,
    languages: ["Ruby"],
    inert: true,
    disabled: true,
    disabledReason: "disabled in banyancode.json",
  },
]

// Regression for the 26.07.21 fatal-error crash. The BanyanCode sidebar LSP
// widget reads `entry.languages`, `entry.inert`, `entry.disabled`, and
// `entry.disabledReason` off every item returned by `state.lsp()`. The TUI
// plugin adapter at `packages/tui/src/plugin/adapters.tsx` was previously
// stripping the `lsp()` items down to `{ id, root, status }`, so those reads
// returned `undefined` and the first Solid render threw
// "undefined is not an object (evaluating 'D1.languages')". The fix passes
// every field through; these tests mount the widgets with the real adapter
// piping a populated sync store through `state.lsp()` and assert no throw.
describe("LSP widgets render with populated LspStatus items", () => {
  function makeState(syncData: { lsp: typeof populatedLsp }) {
    const fakeSync = {
      ready: true,
      data: syncData,
      path: { home: "", state: "", config: "", worktree: "", directory: "" },
      session: { get: () => undefined },
    }
    return stateApi(fakeSync as any)
  }

  test("state.lsp() passes languages/inert/disabled/disabledReason through", () => {
    const state = makeState({ lsp: populatedLsp })
    const items = state.lsp()
    expect(items).toHaveLength(4)
    const first = items[0]
    expect(first.languages).toEqual(["TypeScript", "JavaScript"])
    expect(first.inert).toBe(false)
    expect(first.disabled).toBe(false)
    expect(first.autoDownload).toBe(false)
    expect(first.name).toBe("typescript")
    const disabled = items.find((i) => i.disabled)!
    expect(disabled.disabledReason).toBe("disabled in banyancode.json")
    expect(disabled.languages).toEqual(["Ruby"])
  })

  test("sidebar LSP mounts with active, inert, and disabled servers", async () => {
    const events = createEventSource()
    const calls = createFetch()
    const config = createTuiResolvedConfig()
    const [slotContent, setSlotContent] = createSignal<any>(null)

    function Inner() {
      const api: any = {
        ...createTuiPluginApi({}),
        theme: { current: stubTheme },
        state: {
          ...makeState({ lsp: populatedLsp }),
          banyanConfig: { banyancode_lsp: true },
        },
      }
      api.slots = {
        register: (plugin: any) => {
          if (!plugin?.slots?.sidebar_content) return () => {}
          const el = plugin.slots.sidebar_content({})
          setSlotContent(() => el)
          return () => {}
        },
      }
      void SidebarLsp.tui(api as any, undefined as any, { id: "test" } as any)
      return <box>{slotContent()}</box>
    }

    const setup = await testRender(() => (
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
    ), { width: 80, height: 50 })

    let caught: unknown = null
    try {
      await setup.renderOnce()
      await new Promise((r) => setTimeout(r, 0))
      await setup.renderOnce()
    } catch (err) {
      caught = err
    } finally {
      setup.renderer.destroy()
    }
    expect(caught).toBeNull()
  })

  test("header status-pills mounts with connected and configured servers", async () => {
    const events = createEventSource()
    const calls = createFetch()
    const config = createTuiResolvedConfig()
    const [slotContent, setSlotContent] = createSignal<any>(null)

    function Inner() {
      const api: any = {
        ...createTuiPluginApi({}),
        theme: { current: stubThemeRgba },
        state: {
          ...makeState({ lsp: populatedLsp }),
          session_status: {},
          banyanConfig: { banyancode_lsp: true },
          mcp: () => [],
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
      return <box>{slotContent()}</box>
    }

    const app = await testRender(() => (
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
    ))

    let caught: unknown = null
    try {
      await new Promise((r) => setTimeout(r, 200))
      await app.renderOnce()
    } catch (err) {
      caught = err
    } finally {
      app.renderer.destroy()
    }
    expect(caught).toBeNull()
  })
})


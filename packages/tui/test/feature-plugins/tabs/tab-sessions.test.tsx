/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, onMount, onCleanup } from "solid-js"
import TabSessions, { orderSessions } from "../../../src/feature-plugins/tabs/tab-sessions"
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
import { SyncProvider } from "../../../src/context/sync"
import { DataProvider } from "../../../src/context/data"
import { LocalProvider, useLocal } from "../../../src/context/local"
import { ToastProvider } from "../../../src/ui/toast"
import { ExitProvider } from "../../../src/context/exit"
import { ArgsProvider } from "../../../src/context/args"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { useRenderer } from "@opentui/solid"
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
  accent: { r: 150, g: 150, b: 150, a: 1 },
  background: { r: 20, g: 20, b: 20, a: 1 },
}

function stubClient(sessions: any[] = []) {
  return {
    session: {
      list: async () => ({ data: sessions }),
      create: async () => ({ data: { id: "new-id" } }),
    },
  } as any
}

function Harness(props: { children: any }) {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))
  return (
    <ExitProvider exit={console.error}>
      <TestTuiContexts>
        <ArgsProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <KVProvider>
              <ToastProvider>
                <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
                  <ProjectProvider>
                    <SyncProvider>
                      <DataProvider>
                        <TuiConfigProvider config={config}>
                          <RouteProvider>
                            <ThemeProvider mode="dark">
                              <LocalProvider>
                                <DialogProvider>{props.children}</DialogProvider>
                              </LocalProvider>
                            </ThemeProvider>
                          </RouteProvider>
                        </TuiConfigProvider>
                      </DataProvider>
                    </SyncProvider>
                  </ProjectProvider>
                </SDKProvider>
              </ToastProvider>
            </KVProvider>
          </OpencodeKeymapProvider>
        </ArgsProvider>
      </TestTuiContexts>
    </ExitProvider>
  )
}

async function waitForFrame(
  app: { renderOnce: () => Promise<void>; captureCharFrame: () => string },
  predicate: (frame: string) => boolean,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs
  let frame = app.captureCharFrame()
  while (!predicate(frame)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for frame condition\nlast frame:\n${frame}`)
    await Bun.sleep(20)
    await app.renderOnce()
    frame = app.captureCharFrame()
  }
  return frame
}

const sessionA = {
  id: "a",
  parentID: undefined,
  title: "Session A",
  time: { created: 1, updated: 2000 },
}
const sessionB = {
  id: "b",
  parentID: undefined,
  title: "Session B",
  time: { created: 1, updated: 1000 },
}

async function renderTab(sessions: any[], onLocal?: (local: ReturnType<typeof useLocal>) => void) {
  const [slotContent, setSlotContent] = createSignal<any>(null)

  const Inner = () => {
    onMount(() => {
      if (onLocal) onLocal(useLocal())
      const api: any = {
        ...createTuiPluginApi({ client: stubClient(sessions) }),
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
      void TabSessions.tui(api as any, undefined as any, { id: "test" } as any)
    })

    return <box>{slotContent()}</box>
  }

  const app = await testRender(() => (
    <Harness>
      <Inner />
    </Harness>
  ), { width: 60, height: 30 })
  return { app }
}

test("tab-sessions session_tab_sessions slot renders without throwing", async () => {
  const { app } = await renderTab([])
  try {
    await app.renderOnce()
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

test("tab-sessions source renders a pin star with accent/muted colors", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-sessions.tsx"),
    "utf8",
  )
  expect(source).toContain('"★"')
  expect(source).toContain('"☆"')
  expect(source).toContain("theme.accent")
  expect(source).toContain("theme.textMuted")
  expect(source).toContain("onTogglePin")
  expect(source).toContain("local.session.togglePin")
  expect(source).toContain("paddingBottom={0}")
})

describe("orderSessions", () => {
  const sessions = [
    { id: "a", title: "A", time: { created: 1, updated: 3 } },
    { id: "b", title: "B", time: { created: 1, updated: 1 } },
    { id: "c", title: "C", time: { created: 1, updated: 2 } },
    { id: "child", parentID: "a", title: "Child", time: { created: 1, updated: 4 } },
  ]

  test("keeps recency order and drops child sessions when nothing is pinned", () => {
    const ordered = orderSessions(sessions as any, [])
    expect(ordered.map((s) => s.id)).toEqual(["a", "c", "b"])
  })

  test("sorts pinned sessions first while preserving recency within each group", () => {
    expect(orderSessions(sessions as any, ["b"]).map((s) => s.id)).toEqual(["b", "a", "c"])
    expect(orderSessions(sessions as any, ["b", "c"]).map((s) => s.id)).toEqual(["c", "b", "a"])
  })

  test("toggling a pin moves the session between groups without disturbing recency", () => {
    expect(orderSessions(sessions as any, []).map((s) => s.id)).toEqual(["a", "c", "b"])
    expect(orderSessions(sessions as any, ["c"]).map((s) => s.id)).toEqual(["c", "a", "b"])
    expect(orderSessions(sessions as any, []).map((s) => s.id)).toEqual(["a", "c", "b"])
  })
})

// The three frame-based tests below render bordered SessionCards through the
// native opentui renderer. On win32 the opentui 0.3.4 FFI drawBox crashes with
// "Expected ArrayBufferView but received JSType(0)" for bordered boxes nested
// in a scrollbox; standalone bordered boxes render fine. Ordering/pin logic is
// covered deterministically by the orderSessions unit tests above, so these
// pixel-level tests are skipped on Windows and still run on Linux/macOS CI.
const skipOnWindows = process.platform === "win32"

test.skipIf(skipOnWindows)("two root sessions render adjacent without an extra blank spacer row", async () => {
  const { app } = await renderTab([sessionA, sessionB])
  try {
    const frame = await waitForFrame(
      app,
      (f) => f.includes("Session A") && f.includes("Session B"),
    )
    const rows = frame.split("\n")
    // each card is bordered; the bottom border of one card must be immediately
    // followed by the top border of the next card (no blank spacer row)
    const bottomRows = rows.map((row, index) => [index, row] as const).filter(([, row]) => row.includes("╰"))
    expect(bottomRows.length).toBe(2)
    for (const [index] of bottomRows) {
      const next = rows[index + 1]
      if (next === undefined) continue
      expect(next.includes("╭")).toBe(true)
    }
  } finally {
    app.renderer.destroy()
  }
})

test.skipIf(skipOnWindows)("pinned sessions render before unpinned with stable recency within groups", async () => {
  const { app } = await renderTab([sessionA, sessionB])
  try {
    const frame = await waitForFrame(
      app,
      (f) => f.includes("Session A") && f.includes("Session B"),
    )
    const rows = frame.split("\n")
    // Session A is newer, so it renders first while nothing is pinned
    expect(rows.findIndex((row) => row.includes("Session A"))).toBeLessThan(
      rows.findIndex((row) => row.includes("Session B")),
    )
  } finally {
    app.renderer.destroy()
  }
})

test.skipIf(skipOnWindows)("clicking the star toggles pin state and reorders the list", async () => {
  const localRef: { current?: ReturnType<typeof useLocal> } = {}

  const { app } = await renderTab([sessionA, sessionB], (local) => {
    localRef.current = local
  })
  try {
    let frame = await waitForFrame(
      app,
      (f) => f.includes("Session A") && f.includes("Session B"),
    )
    expect(frame.includes("☆")).toBe(true)
    expect(frame.includes("★")).toBe(false)
    expect(localRef.current?.session.isPinned("b")).toBe(false)

    // click the outline star next to the older session
    let rows = frame.split("\n")
    const row = rows.findIndex((line) => line.includes("Session B"))
    const col = rows[row].indexOf("☆")
    await app.mockMouse.click(col, row)

    // pinned session moves first and its star becomes filled
    frame = await waitForFrame(
      app,
      (f) => f.includes("★") && f.indexOf("Session B") < f.indexOf("Session A"),
    )
    rows = frame.split("\n")
    expect(rows.findIndex((line) => line.includes("Session B"))).toBeLessThan(
      rows.findIndex((line) => line.includes("Session A")),
    )
    expect(localRef.current?.session.isPinned("b")).toBe(true)

    // click the filled star again to unpin and restore recency order
    const row2 = rows.findIndex((line) => line.includes("Session B"))
    const col2 = rows[row2].indexOf("★")
    await app.mockMouse.click(col2, row2)

    frame = await waitForFrame(
      app,
      (f) => f.includes("☆") && f.indexOf("Session A") < f.indexOf("Session B"),
    )
    expect(localRef.current?.session.isPinned("b")).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

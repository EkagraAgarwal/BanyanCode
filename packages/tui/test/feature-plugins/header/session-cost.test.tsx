/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import HeaderSessionCost, { cacheSummary } from "../../../src/feature-plugins/header/session-cost"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { SyncProvider } from "../../../src/context/sync"
import { DataProvider } from "../../../src/context/data"
import { ProjectProvider } from "../../../src/context/project"
import { ExitProvider } from "../../../src/context/exit"
import { ArgsProvider } from "../../../src/context/args"

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

const fixtureSession = {
  id: "session_test",
  cost: 0.0234,
  tokens: { input: 12345, output: 6789, reasoning: 1000, cache: { read: 0, write: 0 } },
  agent: "test-agent",
  model: { id: "test/model" },
  time: { updated: Date.now() },
  title: "Test Session",
}

const childSessions = [
  {
    id: "child_1",
    parentID: "session_test",
    cost: 0.01,
    tokens: { input: 5000, output: 5000, reasoning: 0, cache: { read: 0, write: 0 } },
    agent: "scout",
    model: { id: "test/model" },
    time: { updated: Date.now() },
    title: "Child One",
  },
  {
    id: "child_2",
    parentID: "session_test",
    cost: 0.02,
    tokens: { input: 1000, output: 1000, reasoning: 500, cache: { read: 0, write: 0 } },
    agent: "explore",
    model: { id: "test/model" },
    time: { updated: Date.now() },
    title: "Child Two",
  },
]

test("header session-cost app_top slot renders with cost data", async () => {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  const [slotContent, setSlotContent] = createSignal<any>(null)

  function Inner() {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      client: {
        session: {
          children: async () => ({ data: [] }),
        },
      },
      state: {
        session: { get: () => undefined },
        path: { directory: "/test/workspace" },
        mcp: () => [],
        lsp: () => [],
      },
    }
    api.slots = {
      register: (plugin: any) => {
        if (!plugin?.slots?.app_top) return () => {}
        const el = plugin.slots.app_top({}, { session_id: "session_test" })
        setSlotContent(() => el)
        return () => {}
      },
    }
    onMount(() => {
      HeaderSessionCost.tui(api as any, undefined as any, { id: "test" } as any).catch(() => {})
      queueMicrotask(() => {
        events.emit({
          directory,
          payload: {
            id: "evt_session_updated",
            type: "session.updated",
            properties: { info: fixtureSession },
          } as any,
        })
      })
    })
    return <box>{slotContent()}</box>
  }

  const testSetup = await testRender(() => (
    <ExitProvider exit={console.error}>
      <TestTuiContexts>
        <ArgsProvider>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
              <ProjectProvider>
                <SyncProvider>
                  <DataProvider>
                    <TuiConfigProvider config={config}>
                      <ThemeProvider mode="dark">
                        <Inner />
                      </ThemeProvider>
                    </TuiConfigProvider>
                  </DataProvider>
                </SyncProvider>
              </ProjectProvider>
            </SDKProvider>
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    </ExitProvider>
  ), { width: 100, height: 6 })
  // Let the tree mount and the session.updated event land before pumping the
  // renderer (same pattern as status-pills.test.tsx — pumping before the
  // mount tick leaves the widget unmounted). Poll until the cost row appears
  // so the snapshot is taken from a settled frame even under suite load.
  await Bun.sleep(100)
  let snapshot = ""
  for (let i = 0; i < 100; i++) {
    await testSetup.renderOnce()
    await new Promise((r) => setTimeout(r, 0))
    await testSetup.renderOnce()
    snapshot = testSetup
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd()
    if (snapshot.includes("Session: $")) break
    await Bun.sleep(25)
  }
  try {
    expect(snapshot).toMatchSnapshot()
  } finally {
    testSetup.renderer.destroy()
  }
})

test("header session-cost app_top slot includes subagent costs in the total", async () => {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  const [slotContent, setSlotContent] = createSignal<any>(null)

  function Inner() {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      client: {
        session: {
          children: async () => ({ data: childSessions }),
        },
      },
      state: {
        session: { get: () => undefined },
        path: { directory: "/test/workspace" },
        mcp: () => [],
        lsp: () => [],
      },
    }
    api.slots = {
      register: (plugin: any) => {
        if (!plugin?.slots?.app_top) return () => {}
        const el = plugin.slots.app_top({}, { session_id: "session_test" })
        setSlotContent(() => el)
        return () => {}
      },
    }
    onMount(() => {
      HeaderSessionCost.tui(api as any, undefined as any, { id: "test" } as any).catch(() => {})
      queueMicrotask(() => {
        events.emit({
          directory,
          payload: {
            id: "evt_session_updated",
            type: "session.updated",
            properties: { info: fixtureSession },
          } as any,
        })
      })
    })
    return <box>{slotContent()}</box>
  }

  const testSetup = await testRender(() => (
    <ExitProvider exit={console.error}>
      <TestTuiContexts>
        <ArgsProvider>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
              <ProjectProvider>
                <SyncProvider>
                  <DataProvider>
                    <TuiConfigProvider config={config}>
                      <ThemeProvider mode="dark">
                        <Inner />
                      </ThemeProvider>
                    </TuiConfigProvider>
                  </DataProvider>
                </SyncProvider>
              </ProjectProvider>
            </SDKProvider>
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    </ExitProvider>
  ), { width: 100, height: 6 })
  // Let the tree mount and the session.updated event land before pumping the
  // renderer (same pattern as status-pills.test.tsx — pumping before the
  // mount tick leaves the widget unmounted).
  await Bun.sleep(100)
  // Wait until the session.updated event has landed in the sync store, the
  // children fetch has resolved, and the widget has re-rendered.
  // parent 0.0234 + child_1 0.01 + child_2 0.02 = 0.0534 -> "$0.05"
  // parent 20134 + child_1 10000 + child_2 2500 = 32634 -> "33k"
  let frame = ""
  for (let i = 0; i < 100; i++) {
    await testSetup.renderOnce()
    frame = testSetup.captureCharFrame()
    if (frame.includes("Session: $0.05")) break
    await Bun.sleep(25)
  }
  try {
    expect(frame).toContain("Session: $0.05 · 33k tok (incl. subagents)")
  } finally {
    testSetup.renderer.destroy()
  }
})

// WS7b cached-input readout (prompt-caching-optimization-plan.md).
// Honesty note: cached input is STILL billed — reads at 0.1x, writes at
// 1.25x of the input price. "$saved" is the delta vs paying full input
// price for the same tokens, not free tokens.
test("cacheSummary returns undefined when sessions carry no cache tokens", () => {
  const summary = cacheSummary(
    [{ tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } } }],
    () => 5,
  )
  expect(summary).toBeUndefined()
})

test("cacheSummary computes hit rate over total input and $saved with 0.1x/1.25x multipliers", () => {
  // total input = 300k uncached + 620k read + 80k write = 1M -> 62% hit.
  // saved = (0.9 * 620k - 0.25 * 80k) * $5/1M = $2.69 (writes COST extra,
  // reads save 90%; net is below the 0.9 * read-only ceiling of $3.10).
  const summary = cacheSummary(
    [
      {
        tokens: { input: 300_000, output: 0, reasoning: 0, cache: { read: 620_000, write: 80_000 } },
        model: { id: "test/model", providerID: "test" },
      },
    ],
    () => 5,
  )
  expect(summary?.hitPercent).toBe(62)
  expect(summary?.saved).toBeCloseTo(2.69, 10)
})

test("cacheSummary omits saved when cache writes make caching a net loss", () => {
  // write-only turn: every cache token cost 1.25x, nothing was read back.
  const summary = cacheSummary(
    [
      {
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 100_000 } },
        model: { id: "test/model", providerID: "test" },
      },
    ],
    () => 5,
  )
  expect(summary?.hitPercent).toBe(0)
  expect(summary?.saved).toBeUndefined()
})

test("cacheSummary omits saved when the model input price is unknown", () => {
  const summary = cacheSummary(
    [
      {
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 620_000, write: 80_000 } },
        model: { id: "test/model", providerID: "test" },
      },
    ],
    () => undefined,
  )
  expect(summary?.hitPercent).toBe(89) // round(620k / (620k + 80k)) = 89
  expect(summary?.saved).toBeUndefined()
})

test("cacheSummary aggregates cache tokens across parent and child sessions", () => {
  const summary = cacheSummary(
    [
      { tokens: { input: 100_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 100_000, write: 0 } } },
    ],
    () => undefined,
  )
  expect(summary?.hitPercent).toBe(50)
  expect(summary?.saved).toBeUndefined()
})

test("header session-cost shows cached hit rate and estimated $saved", async () => {
  const events = createEventSource()
  const cachedSession = {
    id: "session_test",
    cost: 0.42,
    tokens: { input: 300_000, output: 0, reasoning: 0, cache: { read: 620_000, write: 80_000 } },
    agent: "test-agent",
    model: { id: "test/model", providerID: "test" },
    time: { updated: Date.now() },
    title: "Cached Session",
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/api/model")
      return json({
        location: { directory, project: { id: "proj_test", directory } },
        data: [
          {
            id: "test/model",
            providerID: "test",
            name: "Test Model",
            cost: [{ input: 5, output: 0, cache: { read: 0.5, write: 6.25 } }],
          },
        ],
      })
    return undefined
  })
  const config = createTuiResolvedConfig()
  const [slotContent, setSlotContent] = createSignal<any>(null)

  function Inner() {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      client: {
        session: {
          children: async () => ({ data: [] }),
        },
      },
      state: {
        session: { get: () => undefined },
        path: { directory: "/test/workspace" },
        mcp: () => [],
        lsp: () => [],
      },
    }
    api.slots = {
      register: (plugin: any) => {
        if (!plugin?.slots?.app_top) return () => {}
        const el = plugin.slots.app_top({}, { session_id: "session_test" })
        setSlotContent(() => el)
        return () => {}
      },
    }
    onMount(() => {
      HeaderSessionCost.tui(api as any, undefined as any, { id: "test" } as any).catch(() => {})
      queueMicrotask(() => {
        events.emit({
          directory,
          payload: {
            id: "evt_session_updated",
            type: "session.updated",
            properties: { info: cachedSession },
          } as any,
        })
      })
    })
    return <box>{slotContent()}</box>
  }

  const testSetup = await testRender(() => (
    <ExitProvider exit={console.error}>
      <TestTuiContexts>
        <ArgsProvider>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
              <ProjectProvider>
                <SyncProvider>
                  <DataProvider>
                    <TuiConfigProvider config={config}>
                      <ThemeProvider mode="dark">
                        <Inner />
                      </ThemeProvider>
                    </TuiConfigProvider>
                  </DataProvider>
                </SyncProvider>
              </ProjectProvider>
            </SDKProvider>
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    </ExitProvider>
  ), { width: 100, height: 6 })
  // Wait for (1) the session.updated event to land in the sync store and
  // (2) DataProvider's /api/model refresh to resolve so the input price is
  // known and $saved can be computed.
  // hit = 620k / (300k + 620k + 80k) = 62%; saved = (0.9*620k - 0.25*80k) * $5/1M = $2.69.
  let frame = ""
  for (let i = 0; i < 200; i++) {
    await testSetup.renderOnce()
    frame = testSetup.captureCharFrame()
    if (frame.includes("saved $")) break
    await Bun.sleep(25)
  }
  try {
    expect(frame).toContain("cached 62%")
    expect(frame).toContain("saved $2.69")
  } finally {
    testSetup.renderer.destroy()
  }
})

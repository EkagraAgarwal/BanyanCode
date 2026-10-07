/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { View } from "../../../src/feature-plugins/header/status-pills"
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

type GraphStatusResponse = {
  data: {
    reason: "ready" | "missing" | "stale" | "building" | "failed"
    autoBuilt?: boolean
    graphBuiltAt?: number
    graphVersion?: number
    graphCoverage?: number
    totalFiles?: number
    warning?: string
    error?: string
  }
}

type GraphStatusMock = (input: { root?: string }) => GraphStatusResponse | Promise<GraphStatusResponse>

async function setupHarness(status?: GraphStatusMock) {
  const events = createEventSource()
  const calls = createFetch()
  const baseApi = createTuiPluginApi({}) as any
  const api: any = {
    ...baseApi,
    theme: { current: stubTheme },
    state: {
      ...(baseApi.state ?? {}),
      session: { get: () => undefined },
      session_status: {},
      path: { directory: "/test/workspace" },
      mcp: () => [{ name: "test-mcp", status: "connected" }],
      lsp: () => [],
    },
    client: {
      session: { list: async () => ({ data: [] }) },
      ...(status
        ? {
            global: {
              codegraph: {
                status: async (input: { root?: string }) => status(input),
              },
            },
          }
        : {}),
    },
  }

  const Harness = () => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <box width={120} height={4}>
                <View api={api} />
              </box>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </SDKProvider>
    </TestTuiContexts>
  )

  const app = await testRender(() => <Harness />, { width: 120, height: 4 })
  let eventID = 0
  const emit = (type: string, properties: Record<string, unknown>) => {
    eventID += 1
    events.emit({
      directory,
      payload: { id: `evt_${eventID}`, type, properties },
    } as any)
  }
  const expectLabel = async (label: string) => {
    let frame = ""
    for (let i = 0; i < 100; i++) {
      await app.renderOnce()
      frame = app.captureCharFrame()
      if (frame.includes(label)) break
      await Bun.sleep(25)
    }
    expect(frame).toContain(label)
  }
  await Bun.sleep(100)
  return { app, emit, expectLabel }
}

describe("header status-pills (graph meta truth)", () => {
  test("Graph: not built when no build event has been seen", async () => {
    const { app, expectLabel } = await setupHarness()
    try {
      await expectLabel("Graph: not built")
    } finally {
      app.renderer.destroy()
    }
  })

  test("Graph: building during a running build", async () => {
    const { app, emit, expectLabel } = await setupHarness()
    try {
      emit("banyancode.codegraph.build", { status: "running", done: 4, total: 10 })
      await expectLabel("Graph: building")
    } finally {
      app.renderer.destroy()
    }
  })

  test("Graph: build failed after a failed build", async () => {
    const { app, emit, expectLabel } = await setupHarness()
    try {
      emit("banyancode.codegraph.build", { status: "failed", done: 4, total: 10, error: "boom" })
      await expectLabel("Graph: build failed")
    } finally {
      app.renderer.destroy()
    }
  })

  test("Graph: syncing (3) during a draining auto-update with pending=3", async () => {
    const { app, emit, expectLabel } = await setupHarness()
    try {
      emit("banyancode.codegraph.auto-update", { status: "draining", pending: 3 })
      await expectLabel("Graph: syncing (3)")
    } finally {
      app.renderer.destroy()
    }
  })

  test("Graph: paused when auto-update is paused", async () => {
    const { app, emit, expectLabel } = await setupHarness()
    try {
      emit("banyancode.codegraph.auto-update", { status: "paused", pending: 0 })
      await expectLabel("Graph: paused")
    } finally {
      app.renderer.destroy()
    }
  })

  test("regression: Graph: built from meta truth even when auto-update is idle", async () => {
    const { app, emit, expectLabel } = await setupHarness()
    try {
      emit("banyancode.codegraph.build", {
        status: "completed",
        graphVersion: 1,
        graphCoverage: 0.9,
        graphBuiltAt: Date.now(),
        totalFiles: 10,
      })
      await expectLabel("Graph: built")
    } finally {
      app.renderer.destroy()
    }
  })

  test("Graph: built (green) on a fresh healthy completed build", async () => {
    const { app, emit, expectLabel } = await setupHarness()
    try {
      // Phase 1: pin the success-side invariant with explicit healthy
      // numbers. graphVersion=5 (not 1) + coverage=0.97 (well above the 0.5
      // stale threshold) + totalFiles=100 + a fresh graphBuiltAt (within
      // the 24h stale window) means the pill must land on `Graph: built`
      // with the `success` (green) severity dot. If any of the new fields
      // (`totalFiles`, `graphBuiltAt`) regresses out of the State schema
      // and the build event payload, this test fails back to "not built"
      // — exactly the bug we fixed.
      emit("banyancode.codegraph.build", {
        status: "completed",
        graphVersion: 5,
        graphCoverage: 0.97,
        graphBuiltAt: Date.now(),
        totalFiles: 100,
      })
      await expectLabel("Graph: built")
    } finally {
      app.renderer.destroy()
    }
  })

  test("Graph: stale when graphBuiltAt is > 24h old and auto-update is idle", async () => {
    const { app, emit, expectLabel } = await setupHarness()
    try {
      const oldTimestamp = Date.now() - 25 * 60 * 60 * 1000
      emit("banyancode.codegraph.build", {
        status: "completed",
        graphVersion: 1,
        graphCoverage: 0.9,
        graphBuiltAt: oldTimestamp,
        totalFiles: 10,
      })
      emit("banyancode.codegraph.auto-update", { status: "idle", pending: 0 })
      await expectLabel("Graph: stale")
    } finally {
      app.renderer.destroy()
    }
  })

  test("priority: a running build event overrides a previous completed state", async () => {
    const { app, emit, expectLabel } = await setupHarness()
    try {
      emit("banyancode.codegraph.build", {
        status: "completed",
        graphVersion: 1,
        graphCoverage: 0.9,
        graphBuiltAt: Date.now(),
        totalFiles: 10,
      })
      await expectLabel("Graph: built")
      emit("banyancode.codegraph.build", { status: "running" })
      await expectLabel("Graph: building")
    } finally {
      app.renderer.destroy()
    }
  })

  // Phase 4: persisted status hydration. No build events are emitted — the
  // pill must rehydrate from the status endpoint after a restart.
  test("persisted ready with no build event → Graph: built", async () => {
    let seenRoot: string | undefined
    const { app, expectLabel } = await setupHarness(async ({ root }) => {
      seenRoot = root
      return {
        data: {
          reason: "ready",
          autoBuilt: false,
          graphVersion: 3,
          graphCoverage: 0.95,
          graphBuiltAt: Date.now(),
          totalFiles: 42,
        },
      }
    })
    try {
      await expectLabel("Graph: built")
      expect(seenRoot).toBe("/test/workspace")
    } finally {
      app.renderer.destroy()
    }
  })

  test("persisted missing → Graph: not built", async () => {
    const { app, expectLabel } = await setupHarness(async () => ({
      data: { reason: "missing", autoBuilt: false },
    }))
    try {
      await expectLabel("Graph: not built")
    } finally {
      app.renderer.destroy()
    }
  })

  test("persisted stale → Graph: stale", async () => {
    // Fresh graphBuiltAt + coverage above the 0.5 threshold means neither the
    // local 24h heuristic nor the coverage heuristic would trigger — only the
    // persisted reason signal can drive the stale label here.
    const { app, expectLabel } = await setupHarness(async () => ({
      data: {
        reason: "stale",
        autoBuilt: false,
        graphVersion: 1,
        graphCoverage: 0.9,
        graphBuiltAt: Date.now(),
        totalFiles: 10,
      },
    }))
    try {
      await expectLabel("Graph: stale")
    } finally {
      app.renderer.destroy()
    }
  })

  test("persisted building → Graph: building", async () => {
    const { app, expectLabel } = await setupHarness(async () => ({
      data: { reason: "building", autoBuilt: false },
    }))
    try {
      await expectLabel("Graph: building")
    } finally {
      app.renderer.destroy()
    }
  })

  test("persisted failed → Graph: build failed", async () => {
    const { app, expectLabel } = await setupHarness(async () => ({
      data: { reason: "failed", autoBuilt: false, error: "boom" },
    }))
    try {
      await expectLabel("Graph: build failed")
    } finally {
      app.renderer.destroy()
    }
  })

  test("first status request rejects, retry succeeds → Graph: built", async () => {
    let statusCalls = 0
    const { app, expectLabel } = await setupHarness(async () => {
      statusCalls += 1
      if (statusCalls === 1) throw new Error("server not ready")
      return {
        data: {
          reason: "ready",
          autoBuilt: false,
          graphVersion: 1,
          graphCoverage: 0.9,
          graphBuiltAt: Date.now(),
          totalFiles: 10,
        },
      }
    })
    try {
      await expectLabel("Graph: built")
      expect(statusCalls).toBe(2)
    } finally {
      app.renderer.destroy()
    }
  })
})

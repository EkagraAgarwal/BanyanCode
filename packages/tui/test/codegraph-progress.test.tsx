import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { CodegraphBuildProvider, CodegraphProgress, useCodegraphBuild } from "../src/component/codegraph-progress"
import { ThemeProvider } from "../src/context/theme"
import { TuiConfigProvider } from "../src/config"
import { KVProvider } from "../src/context/kv"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

describe("CodegraphProgress", () => {
  test("renders without crashing on numeric state updates", async () => {
    let setBuildState: any

    function TestComponent() {
      console.log("TestComponent evaluated")
      const build = useCodegraphBuild()
      setBuildState = build.set
      return <CodegraphProgress />
    }

    const config = createTuiResolvedConfig()
    const Harness = () => {
      console.log("Harness evaluated")
      return (
        <TestTuiContexts>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <CodegraphBuildProvider>
                  <TestComponent />
                </CodegraphBuildProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </TestTuiContexts>
      )
    }

    const app = await testRender(() => <Harness />)

    try {
      // Wait for components to mount and initialize functions
      for (let i = 0; i < 50 && !setBuildState; i++) {
        await new Promise((r) => setTimeout(r, 20))
        await app.renderOnce()
      }

      if (!setBuildState) {
        throw new Error("setBuildState was not initialized (components failed to mount)")
      }

      // Test running
      setBuildState({ status: "running", done: 5, total: 10 })

      // Force render cycle
      await app.renderOnce()

      expect(true).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })

  test("auto-dismisses on failed after 12s", async () => {
    let setBuildState: any
    let capturedState: any

    function TestComponent() {
      const build = useCodegraphBuild()
      setBuildState = build.set
      capturedState = () => build.state
      return <CodegraphProgress />
    }

    const config = createTuiResolvedConfig()
    const Harness = () => (
      <TestTuiContexts>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <CodegraphBuildProvider>
                <TestComponent />
              </CodegraphBuildProvider>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    )

    const app = await testRender(() => <Harness />)

    try {
      // Wait for components to mount and initialize functions
      for (let i = 0; i < 50 && !setBuildState; i++) {
        await new Promise((r) => setTimeout(r, 20))
        await app.renderOnce()
      }
      if (!setBuildState) throw new Error("setBuildState was not initialized")

      setBuildState({ status: "failed", done: 3, total: 10, error: "boom" })
      await app.renderOnce()
      expect(capturedState().status).toBe("failed")

      // Wait past the 12s dismiss timeout. Poll to keep the renderer live
      // and observe the state transition.
      const deadline = Date.now() + 14_000
      while (Date.now() < deadline && capturedState().status !== "idle") {
        await new Promise((r) => setTimeout(r, 100))
        await app.renderOnce()
      }
      expect(capturedState().status).toBe("idle")
    } finally {
      app.renderer.destroy()
    }
  })

  test("auto-dismisses on stuck after 12s", async () => {
    let setBuildState: any
    let capturedState: any

    function TestComponent() {
      const build = useCodegraphBuild()
      setBuildState = build.set
      capturedState = () => build.state
      return <CodegraphProgress />
    }

    const config = createTuiResolvedConfig()
    const Harness = () => (
      <TestTuiContexts>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <CodegraphBuildProvider>
                <TestComponent />
              </CodegraphBuildProvider>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    )

    const app = await testRender(() => <Harness />)

    try {
      for (let i = 0; i < 50 && !setBuildState; i++) {
        await new Promise((r) => setTimeout(r, 20))
        await app.renderOnce()
      }
      if (!setBuildState) throw new Error("setBuildState was not initialized")

      // running state with stale lastProgressAt -> derived status becomes "stuck"
      const stale = Date.now() - 60_000
      setBuildState({ status: "running", done: 1, total: 10, lastProgressAt: stale })
      await app.renderOnce()

      const deadline = Date.now() + 14_000
      while (Date.now() < deadline && capturedState().status !== "idle") {
        await new Promise((r) => setTimeout(r, 100))
        await app.renderOnce()
      }
      expect(capturedState().status).toBe("idle")
    } finally {
      app.renderer.destroy()
    }
  })
})

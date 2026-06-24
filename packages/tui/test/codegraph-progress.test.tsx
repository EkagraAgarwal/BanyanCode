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
})

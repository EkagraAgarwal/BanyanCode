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
      const build = useCodegraphBuild()
      setBuildState = build.set
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

      if (!setBuildState) {
        throw new Error("setBuildState was not initialized (components failed to mount)")
      }

      setBuildState({ status: "running", done: 5, total: 10 })
      await app.renderOnce()

      expect(true).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })
})
/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { ToolUsagePanel } from "../src/components/sidebar/tool-usage"
import { codegraphLive, context, mount, usageLive } from "./harness"

test("the graph summary sits under the TOOL USAGE heading, not above it", async () => {
  const app = await mount(
    () => (
      <ToolUsagePanel
        context={context()}
        usage={usageLive({ tools: [{ toolId: "shell", useCount: 10, lastUsedAt: 1_000 }] })}
        codegraph={codegraphLive({
          meta: {
            graphBuiltAt: Date.now(),
            graphVersion: 6,
            graphCoverage: 1,
            totalFiles: 7,
            totalNodes: 20,
            totalEdges: 12,
          },
        })}
      />
    ),
    { width: 60, height: 12 },
  )

  try {
    const lines = app.captureCharFrame().split("\n").map((line) => line.trim())
    const heading = lines.findIndex((line) => line.includes("TOOL USAGE"))
    const summary = lines.findIndex((line) => line.includes("graph 7 sym"))
    expect(heading).toBeGreaterThanOrEqual(0)
    expect(summary).toBe(heading + 1)
    expect(lines[heading]).not.toContain("graph 7 sym")
    expect(lines.findIndex((line) => line.includes("shell"))).toBeGreaterThan(summary)
  } finally {
    app.renderer.destroy()
  }
})

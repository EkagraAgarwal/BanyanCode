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
    const summary = lines.findIndex((line) => line.includes("graph 7 files"))
    expect(heading).toBeGreaterThanOrEqual(0)
    expect(summary).toBe(heading + 1)
    expect(lines[heading]).not.toContain("graph 7 files")
    expect(lines.findIndex((line) => line.includes("shell"))).toBeGreaterThan(summary)
  } finally {
    app.renderer.destroy()
  }
})

test("swapped calls are counted once and linked back to what they replaced", async () => {
  const app = await mount(
    () => (
      <ToolUsagePanel
        context={context()}
        sessionID="ses_root"
        usage={usageLive({
          tools: [
            { toolId: "repo", useCount: 9, lastUsedAt: 1_000 },
            { toolId: "code_find", useCount: 12, lastUsedAt: 1_000 },
            { toolId: "grep", useCount: 3, lastUsedAt: 1_000 },
          ],
          gateway: {
            rows: [
              { fromTool: "grep", toTool: "code_find", route: "swapped", useCount: 12, bytesSaved: 0, lastUsedAt: 1_000 },
              { fromTool: "read", toTool: "repo", route: "swapped", useCount: 9, bytesSaved: 184_320, lastUsedAt: 1_000 },
            ],
            summary: { swapped: 21, fallback: 5, augmented: 2, direct: 16, bytesSaved: 184_320 },
          },
        })}
        codegraph={codegraphLive()}
      />
    ),
    { width: 60, height: 14 },
  )

  try {
    const frame = app.captureCharFrame()
    const lines = frame.split("\n").map((line) => line.trim())
    // "raw" is direct + augmented: every call that ran the original tool.
    expect(lines.find((line) => line.includes("gateway"))).toBe(
      "gateway 21 swapped · 5 fallback · 18 raw · ~180 KB saved",
    )
    const codeFind = lines.find((line) => line.startsWith("code_find")) ?? ""
    expect(codeFind).toContain("← grep")
    const repo = lines.find((line) => line.startsWith("repo")) ?? ""
    expect(repo).toContain("← read")
    // A tool that only ran directly carries no link.
    const grep = lines.find((line) => line.startsWith("grep")) ?? ""
    expect(grep).not.toContain("←")
  } finally {
    app.renderer.destroy()
  }
})

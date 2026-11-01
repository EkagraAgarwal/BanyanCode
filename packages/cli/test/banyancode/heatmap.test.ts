import { describe, expect, test } from "bun:test"
import {
  buildHeatmapGrid,
  computeHeatmapBuckets,
  dateKey,
  renderHeatmap,
  stripAnsi,
} from "../../src/commands/handlers/banyancode/heatmap"
import { cli, fakeServer, tmpRoot } from "./fixture"

describe("stats heatmap", () => {
  test("buckets activity rows by local date", () => {
    const buckets = computeHeatmapBuckets([
      { date: "2026-01-02", steps: 2 },
      { date: "2026-01-02", steps: 3 },
      { date: "2026-01-03", steps: 1 },
    ])
    expect(buckets.get("2026-01-02")).toBe(5)
    expect(buckets.get("2026-01-03")).toBe(1)
  })

  test("builds a 7-row grid aligned to the window and counts active days", () => {
    const today = new Date(2026, 4, 20)
    const buckets = new Map([
      ["2026-05-19", 10],
      ["2026-05-20", 5],
    ])
    const grid = buildHeatmapGrid(buckets, { today, days: 28 })
    expect(grid.lines).toHaveLength(8)
    expect(grid.days).toBe(28)
    expect(grid.startDate).toBe("2026-04-23")
    expect(grid.endDate).toBe("2026-05-20")
    expect(grid.activeDays).toBe(2)
    expect(grid.total).toBe(15)
    expect(grid.peak).toBe(10)
    expect(grid.peakDate).toBe("2026-05-19")
    // Row labels are Monday-first, four columns wide.
    for (const [index, label] of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].entries()) {
      expect(stripAnsi(grid.lines[index + 1] ?? "").startsWith(label.padEnd(4))).toBe(true)
    }
  })

  test("renders v1's box with step totals", () => {
    const today = new Date(2026, 4, 20)
    const grid = buildHeatmapGrid(new Map([["2026-05-20", 4]]), { today, days: 7 })
    const rendered = renderHeatmap(new Map([["2026-05-20", 4]]), 7, "steps", { today })
    expect(rendered.split("\n")[0]).toStartWith("┌")
    expect(rendered).toContain("ACTIVITY HEATMAP")
    expect(rendered).toContain(`7 days (${grid.startDate} → ${grid.endDate})`)
    expect(rendered).toContain("Total steps")
    expect(rendered).toContain("Active days")
    expect(rendered).toContain("1 / 7")
    expect(rendered.split("\n").at(-1)).toStartWith("└")
  })

  test("dateKey uses the local calendar day", () => {
    expect(dateKey(new Date(2026, 0, 2, 23, 59).getTime())).toBe("2026-01-02")
  })
})

describe("stats --heatmap", () => {
  test("appends the grid after the stats body", async () => {
    const root = await tmpRoot("banyancode-cli-heatmap-")
    const stats = {
      range: { from: Date.UTC(2026, 4, 1), to: Date.UTC(2026, 4, 21) },
      sessions: 1,
      subagents: 0,
      prompts: 2,
      steps: 3,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 0 } },
      cost: 0.5,
      tools: { mode: "summary", totals: { calls: 0, succeeded: 0, failed: 0, unfinished: 0 } },
      activeDays: 2,
      streak: 2,
      activity: [
        { date: dateKey(Date.now() - 86_400_000), steps: 2 },
        { date: dateKey(Date.now()), steps: 1 },
      ],
      models: [],
    }
    const server = fakeServer((_request, url) => {
      if (url.pathname === "/api/experimental/session/stats") return Response.json({ data: stats })
      return undefined
    })
    try {
      const result = await cli(root, ["stats", "--project", "proj_test", "--days", "30", "--heatmap", "--server", server.url])
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("ACTIVITY HEATMAP")
      expect(result.stdout).toContain("Window          30 days")
      expect(result.stdout).toContain("Active days     2 / 30")
    } finally {
      server.stop()
    }
  }, 180_000)
})

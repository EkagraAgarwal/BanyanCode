import { describe, expect, test } from "bun:test"
import { FIXTURES, OFFLINE_NOTE, createReplayFetch, runJevBench } from "../../script/jev-bench"

describe("jev-bench offline replay", () => {
  test("covers one fixture per primitive with canned wire answers", () => {
    const kinds = FIXTURES.map((fixture) => fixture.kind).sort()
    expect(kinds).toEqual(["choice", "noul", "score"])
    expect(OFFLINE_NOTE).toMatch(/not live/i)
  })

  test("replay fetch counts physical requests without network", async () => {
    const replay = createReplayFetch({ decision: { type: "noul", noul: 0.5 } })
    const response = await replay.fetch("https://api.typesafe.ai/v1/systemone", { method: "POST" })
    expect(response.status).toBe(200)
    expect(replay.requests()).toBe(1)
  })

  test("runner completes offline with honest counts and routing", async () => {
    const summary = await runJevBench()
    expect(summary.offline).toBe(true)
    expect(summary.fixtures).toHaveLength(3)
    for (const row of summary.fixtures) {
      expect(row.ok).toBe(true)
      expect(row.reason).toBe("ok")
      expect(row.physicalRequests).toBeGreaterThan(0)
      expect(row.tokens).toBeGreaterThan(0)
      expect(row.estCostUsd).toBeDefined()
    }
    expect(summary.totalPhysicalRequests).toBe(summary.fixtures.reduce((sum, row) => sum + row.physicalRequests, 0))
    expect(summary.disabledRouting).toBe("disabled")
    expect(summary.missingKeyRouting).toBe("missing-key")
    expect(summary.note).toMatch(/fixture-derived/i)
  })

  test("invalid external fixture path is skipped without failing", async () => {
    const summary = await runJevBench({ fixturePath: "/nonexistent/jev-fixture.json" })
    expect(summary.external).toBeUndefined()
    expect(summary.externalSkipped).toContain("missing file")
    expect(summary.fixtures.every((row) => row.ok)).toBe(true)
  })
})

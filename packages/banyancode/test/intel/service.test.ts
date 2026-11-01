import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { Effect } from "effect"
import { make } from "../../src/intel/service.js"
import { countStaleFilesFor, isStale } from "../../src/intel/staleness.js"
import { buildProject } from "./graph-fixture.js"

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

const setup = async () => {
  const project = await buildProject()
  roots.push(project.root)
  return { ...project, intel: make(project.fixture.port) }
}

describe("repository intelligence service", () => {
  test("query returns symbols, graph slice, tests and ranking signals", async () => {
    const { fixture, intel } = await setup()
    const ctx = await Effect.runPromise(intel.query({ query: "MemoryRepo", limit: 10 }))

    expect(ctx.status).toBe("success")
    expect(ctx.symbols.map((node) => node.name)).toContain("MemoryRepo")
    expect(ctx.tests.length).toBeGreaterThan(0)
    expect(ctx.graph.edges.length).toBeGreaterThan(0)
    expect(ctx.files.length).toBeGreaterThan(0)
    expect(ctx.ranking.signals.exact).toBeGreaterThan(0)
    expect(ctx.git.ownership).toEqual([])

    const slice = await Effect.runPromise(intel.slice(ctx))
    expect(slice.summary).toContain('Query "MemoryRepo"')
    expect(slice.importantSymbols.map((node) => node.name)).toContain("MemoryRepo")
    expect(fixture.rows.nodes.length).toBe(9)
  })

  test("explain and trace surface callers and dependents", async () => {
    const { intel } = await setup()
    const explain = await Effect.runPromise(intel.explain({ symbol: "MemoryRepo.update" }))
    // slice drops test-file callers (v1 behavior); preflight keeps them.
    expect(explain.directCallers.length).toBe(5)
    expect(explain.transitiveDependents.map((node) => node.name)).toEqual(["boot"])

    const trace = await Effect.runPromise(intel.trace({ symbol: "MemoryRepo.update", depth: 3 }))
    expect(trace.directCallers.length).toBeGreaterThan(0)
    expect(trace.transitiveDependents.map((node) => node.name)).toContain("boot")
  })

  test("impact of a file aggregates dependents; tests and relationships resolve", async () => {
    const { intel } = await setup()
    const impact = await Effect.runPromise(intel.impact({ path: "packages/core/src/memory-repo.ts" }))
    expect(impact.directCallers.length).toBeGreaterThan(0)
    expect(impact.importantSymbols.map((node) => node.name)).toContain("update")

    const tests = await Effect.runPromise(intel.tests({ symbol: "MemoryRepo.update" }))
    expect(tests.derivation).toBe("tested_by")
    expect(tests.tests.map((node) => node.name)).toEqual(["MemoryRepo.update test"])

    const symbols = await Effect.runPromise(intel.symbols({ query: "MemoryRepo", limit: 10 }))
    expect(symbols.map((node) => node.name)).toContain("MemoryRepo")

    const relationships = await Effect.runPromise(
      intel.relationships({ path: "packages/core/src/session.ts", depth: 1 }),
    )
    expect(relationships.map((node) => node.id)).toContain("node-update")
  })

  test("query degrades with a diagnostic when nothing matches", async () => {
    const { intel } = await setup()
    const ctx = await Effect.runPromise(intel.query({ query: "zzz-no-such-symbol" }))
    expect(ctx.status).toBe("failed")
    expect(ctx.degraded).toBe(true)
    expect(ctx.diagnostics?.map((diagnostic) => diagnostic.kind)).toContain("symbol-not-found")
    expect(ctx.symbols).toEqual([])
  })

  test("staleness helpers read meta age/coverage and per-file drift", async () => {
    const { fixture, meta } = await setup()
    expect(isStale({ graphBuiltAt: meta.graphBuiltAt, graphCoverage: meta.graphCoverage }).stale).toBe(false)
    expect(
      isStale({
        graphBuiltAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
        graphCoverage: 0.9,
      }).severity,
    ).toBe("high")
    expect(isStale(undefined).stale).toBe(true)

    const fresh = await Effect.runPromise(countStaleFilesFor(fixture.port, ["file-repo", "file-session"]))
    expect(fresh).toEqual({ stale: false, staleFiles: 0 })
  })
})

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { CodegraphAnalyzer, defaultLayer as codegraphAnalyzerDefaultLayer } from "../../src/banyancode/codegraph-analyzer"
import { RepositoryIntelligence, defaultLayer as repositoryIntelligenceDefaultLayer } from "../../src/banyancode/repository-intelligence"
import { computeBlastRadius } from "../../src/tool/blast-radius"
import { computePreflight } from "../../src/tool/preflight"
import { isStale } from "../../src/banyancode/graph-staleness"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000 // fixed timestamp for deterministic tests

// ---------------------------------------------------------------------------
// Pure isStale unit tests
// ---------------------------------------------------------------------------

describe("isStale", () => {
  test("fresh graph (0 hours) → not stale", () => {
    const meta = { graphBuiltAt: NOW, graphCoverage: 0.9 }
    expect(isStale(meta, NOW)).toEqual({ stale: false })
  })

  test("graph built 12 hours ago → not stale", () => {
    const meta = { graphBuiltAt: NOW - 12 * 60 * 60 * 1000, graphCoverage: 0.9 }
    expect(isStale(meta, NOW)).toEqual({ stale: false })
  })

  test("graph built 1 day + 1 second ago → stale, med severity", () => {
    const meta = { graphBuiltAt: NOW - (ONE_DAY_MS + 1000), graphCoverage: 0.9 }
    const result = isStale(meta, NOW)
    expect(result.stale).toBe(true)
    expect(result.severity).toBe("med")
    expect(result.reason).toContain("1 day old")
  })

  test("graph built 3 days ago → stale, med severity", () => {
    const meta = { graphBuiltAt: NOW - 3 * ONE_DAY_MS, graphCoverage: 0.9 }
    const result = isStale(meta, NOW)
    expect(result.stale).toBe(true)
    expect(result.severity).toBe("med")
    expect(result.reason).toContain("3 days old")
  })

  test("graph built 7 days + 1 second ago → stale, high severity", () => {
    const meta = { graphBuiltAt: NOW - (7 * ONE_DAY_MS + 1000), graphCoverage: 0.9 }
    const result = isStale(meta, NOW)
    expect(result.stale).toBe(true)
    expect(result.severity).toBe("high")
    expect(result.reason).toContain("7 days old")
  })

  test("graph built 14 days ago → stale, high severity", () => {
    const meta = { graphBuiltAt: NOW - 14 * ONE_DAY_MS, graphCoverage: 0.9 }
    const result = isStale(meta, NOW)
    expect(result.stale).toBe(true)
    expect(result.severity).toBe("high")
    expect(result.reason).toContain("14 days old")
  })

  test("graph coverage 49% → stale, high severity (low coverage)", () => {
    const meta = { graphBuiltAt: NOW, graphCoverage: 0.49 }
    const result = isStale(meta, NOW)
    expect(result.stale).toBe(true)
    expect(result.severity).toBe("high")
    expect(result.reason).toContain("coverage")
    expect(result.reason).toContain("49%")
  })

  test("graph coverage 50% → not stale (boundary)", () => {
    const meta = { graphBuiltAt: NOW - ONE_DAY_MS, graphCoverage: 0.5 }
    expect(isStale(meta, NOW)).toEqual({ stale: false })
  })

  test("graph coverage 51% + stale age → high severity wins (coverage low first)", () => {
    const meta = { graphBuiltAt: NOW - ONE_DAY_MS, graphCoverage: 0.49 }
    const result = isStale(meta, NOW)
    expect(result.stale).toBe(true)
    expect(result.severity).toBe("high")
    expect(result.reason).toContain("coverage")
  })

  test("meta undefined (never built) → stale, high severity", () => {
    const result = isStale(undefined, NOW)
    expect(result.stale).toBe(true)
    expect(result.severity).toBe("high")
    expect(result.reason).toContain("not been built")
  })
})

// ---------------------------------------------------------------------------
// Integration tests — stale-graph signal propagates into tool outputs
// ---------------------------------------------------------------------------

const seedNode = {
  id: "f1:n1",
  fileID: "f1",
  kind: "function" as const,
  name: "helper",
  signature: "function helper()",
  startLine: 1,
  endLine: 5,
  code: "export function helper() {}",
}

describe("stale-graph signal integration with tools", () => {
  test("code_find (via isStale check) returns stale when graphBuiltAt is 8 days old", async () => {
    const seed = Effect.gen(function* () {
      const repo = yield* CodegraphRepo.Service
      yield* repo.writeFileGraph({
        file: { id: "f1", path: "src/helper.ts", contentHash: "h1", language: "typescript", indexedAt: 1 },
        nodes: [seedNode],
        edges: [],
      })
      yield* repo.setMeta({
        id: "singleton",
        graphBuiltAt: NOW - 8 * ONE_DAY_MS,
        graphVersion: 1,
        graphCoverage: 0.9,
        totalFiles: 1,
        totalNodes: 1,
        totalEdges: 0,
        schemaVersion: 1,
      })
    })
    const testEff = Effect.gen(function* () {
      const repo = yield* CodegraphRepo.Service
      const meta = yield* repo.getMeta()
      expect(meta).toBeDefined()
      const stale = isStale({ graphBuiltAt: meta!.graphBuiltAt, graphCoverage: meta!.graphCoverage }, NOW)
      expect(stale.stale).toBe(true)
      expect(stale.severity).toBe("high")
    })
    await runWithSeed(seed, testEff)
  })

  test("blast_radius sets graphStale=true when coverage is below 50%", async () => {
    const seed = Effect.gen(function* () {
      const repo = yield* CodegraphRepo.Service
      yield* repo.writeFileGraph({
        file: { id: "f1", path: "src/helper.ts", contentHash: "h1", language: "typescript", indexedAt: 1 },
        nodes: [seedNode],
        edges: [],
      })
      yield* repo.setMeta({
        id: "singleton",
        graphBuiltAt: NOW,
        graphVersion: 1,
        graphCoverage: 0.3,
        totalFiles: 1,
        totalNodes: 1,
        totalEdges: 0,
        schemaVersion: 1,
      })
    })
    const testEff = Effect.gen(function* () {
      const repo = yield* CodegraphRepo.Service
      const analyzer = yield* CodegraphAnalyzer.Service
      const result = yield* computeBlastRadius({ repo, analyzer }, { target: "helper" })
      expect((result as any).graphStale).toBe(true)
    })
    await runWithSeed(seed, testEff)
  })

  test("preflight pushes stale-graph risk when graph is 8 days old", async () => {
    const eightDaysAgo = Date.now() - 8 * ONE_DAY_MS
    const seed = Effect.gen(function* () {
      const repo = yield* CodegraphRepo.Service
      yield* repo.writeFileGraph({
        file: { id: "f1", path: "src/helper.ts", contentHash: "h1", language: "typescript", indexedAt: 1 },
        nodes: [seedNode],
        edges: [],
      })
      yield* repo.setMeta({
        id: "singleton",
        graphBuiltAt: eightDaysAgo,
        graphVersion: 1,
        graphCoverage: 0.9,
        totalFiles: 1,
        totalNodes: 1,
        totalEdges: 0,
        schemaVersion: 1,
      })
    })
    const testEff = Effect.gen(function* () {
      const repo = yield* CodegraphRepo.Service
      const analyzer = yield* CodegraphAnalyzer.Service
      const intel = yield* RepositoryIntelligence.Service
      const result = yield* computePreflight({ repo, analyzer, intel }, { action: "modify", target: "helper" })
      const risks = (result as any).risks as Array<{ kind: string; message: string }>
      const staleRisk = risks.find((r: { kind: string }) => r.kind === "stale-graph")
      expect(staleRisk).toBeDefined()
      const msg = (staleRisk as { message: string }).message
      expect(msg).toContain("8 days old")
    })
    await runWithSeed(seed, testEff)
  })

  test("preflight pushes stale-graph risk when graph has never been built", async () => {
    const seed = Effect.succeed(undefined) // empty graph
    const testEff = Effect.gen(function* () {
      const repo = yield* CodegraphRepo.Service
      const analyzer = yield* CodegraphAnalyzer.Service
      const intel = yield* RepositoryIntelligence.Service
      const result = yield* computePreflight({ repo, analyzer, intel }, { action: "modify", target: "helper" })
      const risks = (result as any).risks as Array<{ kind: string; message: string }>
      const staleRisk = risks.find((r: { kind: string }) => r.kind === "stale-graph")
      expect(staleRisk).toBeDefined()
      const msg = (staleRisk as { message: string }).message
      expect(msg).toContain("not been built")
    })
    await runWithSeed(seed, testEff)
  })
})

async function runWithSeed(seed: Effect.Effect<unknown, any, any>, test: Effect.Effect<unknown, any, any>): Promise<void> {
  const tmp = await tmpdir()
  const dbPath = path.join(tmp.path, "test.db")
  const dbLayer = Database.layerFromPath(dbPath)
  const testLayer = Layer.mergeAll(
    codegraphRepoDefaultLayer,
    codegraphAnalyzerDefaultLayer,
    repositoryIntelligenceDefaultLayer,
  )
  const program = Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* DatabaseMigration.apply(db)
    yield* seed
    return yield* test
  })
  try {
    await Effect.runPromise(
      program.pipe(
        Effect.provide(testLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ) as Effect.Effect<unknown, never, never>,
    )
  } finally {
    await tmp[Symbol.asyncDispose]()
  }
}

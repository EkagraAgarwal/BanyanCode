import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import {
  computeBlastRadius,
  Input,
  makeBlastRadiusTool,
  name,
  Output,
} from "../../src/tool/blast-radius"
import {
  CodegraphRepo,
  defaultLayer as codegraphRepoDefaultLayer,
} from "../../src/banyancode/codegraph-repo"
import {
  CodegraphAnalyzer,
  defaultLayer as codegraphAnalyzerDefaultLayer,
} from "../../src/banyancode/codegraph-analyzer"
import type { CodegraphFile, CodegraphNode } from "../../src/banyancode/types"
import type { Interface as CodegraphRepoInterface } from "../../src/banyancode/codegraph-repo"
import type { Interface as CodegraphAnalyzerInterface } from "../../src/banyancode/codegraph-analyzer"
import type { Interface as CodegraphReadinessInterface } from "../../src/banyancode/codegraph-readiness"
import type { Interface as RepositoryIntelligenceInterface } from "../../src/banyancode/repository-intelligence/service"
import type { Interface as PermissionV2Interface } from "../../src/permission"
import { computePreflight } from "../../src/tool/preflight"

process.env.BANYANCODE_ENABLE = "1"

const mockPermission = {
  assert: () => Effect.void,
  ask: () => Effect.void,
  reply: () => Effect.void,
  configured: () => Effect.void,
  list: () => Effect.succeed([]),
  get: () => Effect.void,
  forSession: () => Effect.void,
} as unknown as PermissionV2Interface

const mockReadiness: CodegraphReadinessInterface = {
  ensureReady: () => Effect.succeed({ reason: "ready", autoBuilt: false }),
  status: () => Effect.succeed({ reason: "ready", autoBuilt: false }),
}

const buildProvider = (
  repo: CodegraphRepoInterface,
  analyzer: CodegraphAnalyzerInterface,
  permission: PermissionV2Interface,
  intel: RepositoryIntelligenceInterface,
) => makeBlastRadiusTool({ permission, repo, analyzer, intel, readiness: mockReadiness })

// `intel.tests()` consults per-file imports/edges in the seeded graph. The
// `alpha` symbol here has both a `.test.ts` caller AND a non-test caller, so
// `tests({ symbol: "alpha" })` should pick up the test node we seeded.
const buildIntel = (repo: CodegraphRepoInterface): RepositoryIntelligenceInterface => {
  const testsCallsInRepo = (symbol: string) =>
    Effect.gen(function* () {
      const allNodes = yield* repo.listAllNodes()
      const allEdges = yield* repo.listAllEdges()
      const targetIDs = new Set(
        allNodes.filter((n) => n.name === symbol).map((n) => n.id),
      )
      const seen = new Set<string>()
      for (const e of allEdges) {
        if (targetIDs.has(e.toNodeID)) {
          const from = allNodes.find((n) => n.id === e.fromNodeID)
          if (from) seen.add(from.id)
        }
      }
      const tests = allNodes.filter((n) => seen.has(n.id) && n.kind === "test")
      return { tests, notFound: tests.length === 0, derivation: "import" as const }
    })
  return {
    query: () => Effect.die("not used"),
    slice: () => Effect.die("not used"),
    explain: () => Effect.die("not used"),
    impact: () => Effect.die("not used"),
    trace: () => Effect.die("not used"),
    tests: (input) => testsCallsInRepo(input.symbol),
    symbols: () => Effect.succeed([]),
    relationships: () => Effect.succeed([]),
    findOwner: () => Effect.succeed({ count: 0 }),
  }
}

const seedCallerGraph = (repo: CodegraphRepoInterface) =>
  Effect.gen(function* () {
    const fileA: CodegraphFile = {
      id: "file-a",
      path: "src/target.ts",
      contentHash: "h-a",
      language: "typescript",
      indexedAt: 1,
    }
    const fileB: CodegraphFile = {
      id: "file-b",
      path: "src/caller1.ts",
      contentHash: "h-b",
      language: "typescript",
      indexedAt: 2,
    }
    const fileC: CodegraphFile = {
      id: "file-c",
      path: "src/caller2.test.ts",
      contentHash: "h-c",
      language: "typescript",
      indexedAt: 3,
    }
    yield* repo.putFile(fileA)
    yield* repo.putFile(fileB)
    yield* repo.putFile(fileC)

    const targetNode: CodegraphNode = {
      id: "node-target",
      fileID: "file-a",
      kind: "function",
      name: "alpha",
      startLine: 1,
      endLine: 10,
    }
    yield* repo.putNode(targetNode)
    yield* repo.putNode({
      id: "node-caller1",
      fileID: "file-b",
      kind: "function",
      name: "usesAlpha",
      startLine: 1,
      endLine: 5,
    })
    yield* repo.putNode({
      id: "node-caller2",
      fileID: "file-c",
      kind: "test",
      name: "alphaSpec",
      startLine: 1,
      endLine: 5,
    })
    yield* repo.putEdge({
      id: "edge-b-target",
      fromNodeID: "node-caller1",
      toNodeID: "node-target",
      kind: "calls",
    })
    yield* repo.putEdge({
      id: "edge-c-target",
      fromNodeID: "node-caller2",
      toNodeID: "node-target",
      kind: "references",
    })
  })

const testLayer = Layer.mergeAll(codegraphAnalyzerDefaultLayer, codegraphRepoDefaultLayer)

describe("blast_radius tool", () => {
  test("name, Input and Output schemas have correct shape", () => {
    expect(name).toBe("blast_radius")
    expect(Input.fields).toHaveProperty("target")
    expect(Input.fields).toHaveProperty("maxDepth")
    expect((Output as unknown as { fields: Record<string, unknown> }).fields).toHaveProperty("risk")
    expect((Output as unknown as { fields: Record<string, unknown> }).fields).toHaveProperty("resolved")
  })

  test("computeBlastRadius returns 2 direct callers + tests when seeded graph has two callers", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        const analyzer = yield* CodegraphAnalyzer.Service
        yield* seedCallerGraph(repo as unknown as CodegraphRepoInterface)
        const intel = buildIntel(repo as unknown as CodegraphRepoInterface)

        const result = yield* computeBlastRadius(
          {
            repo: repo as unknown as CodegraphRepoInterface,
            analyzer: analyzer as unknown as CodegraphAnalyzerInterface,
            intel,
          },
          { target: "alpha" },
        )

        expect(result.directCallers).toBe(2)
        expect(result.transitiveCallers).toBeGreaterThanOrEqual(0)
        expect(result.filesAffected).toBeGreaterThanOrEqual(2)
        expect(result.testsToRun).toBeGreaterThanOrEqual(1)
        expect(["low", "medium", "high"]).toContain(result.risk)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("computeBlastRadius returns zero counts and 'unknown' risk when target is not in graph", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        const analyzer = yield* CodegraphAnalyzer.Service
        yield* seedCallerGraph(repo as unknown as CodegraphRepoInterface)
        const intel = buildIntel(repo as unknown as CodegraphRepoInterface)

        const result = yield* computeBlastRadius(
          {
            repo: repo as unknown as CodegraphRepoInterface,
            analyzer: analyzer as unknown as CodegraphAnalyzerInterface,
            intel,
          },
          { target: "noSuchSymbol_xyz123" },
        )

        expect(result.directCallers).toBe(0)
        expect(result.transitiveCallers).toBe(0)
        expect(result.filesAffected).toBe(0)
        expect(result.testsToRun).toBe(0)
        expect(result.risk).toBe("unknown")
        expect(result.resolved).toBe(false)
        expect(result.resolutionDerivation).toBeUndefined()
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("computeBlastRadius returns resolved=true with derivation when target exists", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        const analyzer = yield* CodegraphAnalyzer.Service
        yield* seedCallerGraph(repo as unknown as CodegraphRepoInterface)
        const intel = buildIntel(repo as unknown as CodegraphRepoInterface)

        const result = yield* computeBlastRadius(
          {
            repo: repo as unknown as CodegraphRepoInterface,
            analyzer: analyzer as unknown as CodegraphAnalyzerInterface,
            intel,
          },
          { target: "alpha" },
        )

        expect(result.resolved).toBe(true)
        expect(result.resolutionDerivation).toBe("name-exact")
        expect(["low", "medium", "high"]).toContain(result.risk)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("makeBlastRadiusTool builds a tool whose name matches and factories return distinct instances", () => {
    const analyzerStub: CodegraphAnalyzerInterface = {
      callers: () => Effect.succeed([]),
      dependents: () => Effect.succeed([]),
      impact: () =>
        Effect.succeed({
          dependents: [] as Array<CodegraphNode>,
          transitive: [] as Array<CodegraphNode>,
        }),
      walkTransitive: () => Effect.succeed([]),
    }
    const repoStub: CodegraphRepoInterface = {
      listAllFiles: () => Effect.succeed([]),
    } as unknown as CodegraphRepoInterface
    const intelStub = buildIntel(repoStub)

    const toolA = buildProvider(repoStub, analyzerStub, mockPermission, intelStub)
    const toolB = buildProvider(repoStub, analyzerStub, mockPermission, intelStub)
    expect(toolA).toBeDefined()
    expect(toolB).toBeDefined()
    expect(toolA).not.toBe(toolB)
  })

  test("blast_radius.testsToRun agrees with preflight.testsToRun.length for target with caller + test files", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        const analyzer = yield* CodegraphAnalyzer.Service
        yield* seedCallerGraph(repo as unknown as CodegraphRepoInterface)
        const intel = buildIntel(repo as unknown as CodegraphRepoInterface)

        const blast = yield* computeBlastRadius(
          {
            repo: repo as unknown as CodegraphRepoInterface,
            analyzer: analyzer as unknown as CodegraphAnalyzerInterface,
            intel,
          },
          { target: "alpha" },
        )

        // Mirror preflight's testsToRun shape: union caller-path test files
        // with `intel.tests({ symbol })`. Both counts must agree.
        const preflight = yield* computePreflight(
          {
            repo: repo as unknown as CodegraphRepoInterface,
            analyzer: analyzer as unknown as CodegraphAnalyzerInterface,
            intel,
          },
          { action: "modify", target: "alpha" },
        )

        expect(blast.testsToRun).toBeGreaterThanOrEqual(1)
        expect(blast.testsToRun).toBe(preflight.testsToRun.length)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

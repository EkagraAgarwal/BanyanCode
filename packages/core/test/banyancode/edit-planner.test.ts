import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import {
  EditPlanner,
  layer as editPlannerLayer,
} from "../../src/banyancode/edit-planner"
import {
  CodegraphRepo,
  defaultLayer as codegraphRepoDefaultLayer,
} from "../../src/banyancode/codegraph-repo"
import {
  CodegraphAnalyzer,
  defaultLayer as codegraphAnalyzerDefaultLayer,
} from "../../src/banyancode/codegraph-analyzer"
import type { CodegraphNode, CodegraphFile, CodegraphMeta } from "../../src/banyancode/types"

process.env.BANYANCODE_ENABLE = "1"

const makeMockRepo = (options: {
  nodes?: CodegraphNode[]
  files?: CodegraphFile[]
  meta?: CodegraphMeta
}) => {
  return Layer.succeed(
    CodegraphRepo.Service,
    CodegraphRepo.Service.of({
      listAllNodes: () => Effect.succeed(options.nodes ?? []),
      listAllFiles: () => Effect.succeed(options.files ?? []),
      getMeta: () => Effect.succeed(options.meta),
      getFileByPath: (p) => Effect.succeed(options.files?.find((f) => f.path === p)),
      nodeByID: (id) => Effect.succeed(options.nodes?.find((n) => n.id === id)),
      listNodesByFile: (fileID) => Effect.succeed(options.nodes?.filter((n) => n.fileID === fileID) ?? []),
      queryNodes: () => Effect.succeed(options.nodes ?? []),
      searchNodes: () => Effect.succeed([]),
      countNodes: () => Effect.succeed(options.nodes?.length ?? 0),
      countEdges: () => Effect.succeed(0),
      countFiles: () => Effect.succeed(0),
      edgesFrom: () => Effect.succeed([]),
      edgesTo: () => Effect.succeed([]),
      putFile: () => Effect.void,
      getFile: () => Effect.succeed(undefined),
      putNode: () => Effect.void,
      getNode: () => Effect.succeed(undefined),
      putEdge: () => Effect.void,
      getEdge: () => Effect.succeed(undefined),
      listAllEdges: () => Effect.succeed([]),
      listEdgesByNode: () => Effect.succeed([]),
      deleteFile: () => Effect.void,
      clearAll: () => Effect.void,
      setMeta: () => Effect.void,
      bumpVersion: () => Effect.succeed({ graphVersion: 1, coverage: 1 }),
    }),
  )
}

const makeMockAnalyzer = (options: {
  callers?: CodegraphNode[]
  dependents?: CodegraphNode[]
  impactResult?: { dependents: CodegraphNode[]; transitive: CodegraphNode[] }
}) => {
  return Layer.succeed(
    CodegraphAnalyzer.Service,
    CodegraphAnalyzer.Service.of({
      callers: () => Effect.succeed(options.callers ?? []),
      dependents: () => Effect.succeed(options.dependents ?? []),
      impact: () => Effect.succeed(options.impactResult ?? { dependents: [], transitive: [] }),
      walkTransitive: () => Effect.succeed([]),
    }),
  )
}

describe("EditPlanner", () => {
  const now = Date.now()
  const oneDayMs = 24 * 60 * 60 * 1000
  const oneWeekMs = 7 * oneDayMs

  const targetNode: CodegraphNode = {
    id: "node1",
    fileID: "file1",
    kind: "function",
    name: "myFunction",
    signature: "function myFunction()",
    startLine: 10,
    endLine: 20,
  }

  const testFileNode: CodegraphNode = {
    id: "node2",
    fileID: "file2",
    kind: "function",
    name: "testMe",
    signature: "function testMe()",
    startLine: 5,
    endLine: 15,
  }

  const files: CodegraphFile[] = [
    { id: "file1", path: "/src/myFunction.ts", contentHash: "abc", language: "typescript", indexedAt: Date.now() },
    { id: "file2", path: "/src/__tests__/testMe.test.ts", contentHash: "def", language: "typescript", indexedAt: Date.now() },
    { id: "file3", path: "/src/utils.ts", contentHash: "ghi", language: "typescript", indexedAt: Date.now() },
  ]

  test("planBeforeEdit rename returns steps and impact", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const nodes = [targetNode]
    const mockRepo = makeMockRepo({ nodes, files })
    const mockAnalyzer = makeMockAnalyzer({
      impactResult: {
        dependents: [testFileNode],
        transitive: [testFileNode],
      },
    })

    const serviceLayer = editPlannerLayer.pipe(
      Layer.provideMerge(mockRepo),
      Layer.provideMerge(mockAnalyzer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const planner = yield* EditPlanner.Service
        const plan = yield* planner.planBeforeEdit({
          targetSymbol: "myFunction",
          changeKind: "rename",
        })

        expect(plan.steps.length).toBeGreaterThan(0)
        expect(plan.expectedImpact.directDependents).toBe(1)
        expect(plan.expectedImpact.transitiveDependents).toBe(1)
        expect(plan.risks.length).toBeGreaterThanOrEqual(0)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("planBeforeEdit modify on missing target returns grep and no-target high risk", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockRepo = makeMockRepo({ nodes: [], files: [] })
    const mockAnalyzer = makeMockAnalyzer({})

    const serviceLayer = editPlannerLayer.pipe(
      Layer.provideMerge(mockRepo),
      Layer.provideMerge(mockAnalyzer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const planner = yield* EditPlanner.Service
        const plan = yield* planner.planBeforeEdit({
          targetSymbol: "nonexistent",
          changeKind: "modify",
        })

        expect(plan.steps.map((s) => s.tool)).toContain("grep")
        const noTargetRisk = plan.risks.find((r) => r.kind === "no-target")
        expect(noTargetRisk?.severity).toBe("high")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("planBeforeEdit add returns 0 dependents and no-target low risk", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockRepo = makeMockRepo({
      nodes: [{ id: "n1", fileID: "f1", kind: "function", name: "existingFunc", startLine: 1, endLine: 10 }],
      files: [{ id: "f1", path: "/src/existing.ts", contentHash: "abc", language: "typescript", indexedAt: Date.now() }],
    })
    const mockAnalyzer = makeMockAnalyzer({})

    const serviceLayer = editPlannerLayer.pipe(
      Layer.provideMerge(mockRepo),
      Layer.provideMerge(mockAnalyzer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const planner = yield* EditPlanner.Service
        const plan = yield* planner.planBeforeEdit({
          targetSymbol: "newFunction",
          changeKind: "add",
        })

        expect(plan.expectedImpact.directDependents).toBe(0)
        expect(plan.expectedImpact.transitiveDependents).toBe(0)
        const noTargetRisk = plan.risks.find((r) => r.kind === "no-target")
        expect(noTargetRisk?.severity).toBe("low")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("planBeforeEdit flags stale-graph when graphBuiltAt > 1 day", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const twoDaysAgo = now - 2 * oneDayMs
    const mockRepo = makeMockRepo({
      nodes: [targetNode],
      files,
      meta: { id: "singleton", graphBuiltAt: twoDaysAgo, graphCoverage: 0.9, graphVersion: 1, totalFiles: 10, totalNodes: 100, totalEdges: 200, schemaVersion: 1 },
    })
    const mockAnalyzer = makeMockAnalyzer({
      impactResult: { dependents: [], transitive: [] },
    })

    const serviceLayer = editPlannerLayer.pipe(
      Layer.provideMerge(mockRepo),
      Layer.provideMerge(mockAnalyzer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const planner = yield* EditPlanner.Service
        const plan = yield* planner.planBeforeEdit({
          targetSymbol: "myFunction",
          changeKind: "modify",
        })

        const staleRisk = plan.risks.find((r) => r.kind === "stale-graph")
        expect(staleRisk).toBeDefined()
        expect(staleRisk?.severity).toBe("med")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("planBeforeEdit flags stale-graph high when coverage < 0.5", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockRepo = makeMockRepo({
      nodes: [targetNode],
      files,
      meta: { id: "singleton", graphBuiltAt: now - oneDayMs, graphCoverage: 0.3, graphVersion: 1, totalFiles: 100, totalNodes: 50, totalEdges: 100, schemaVersion: 1 },
    })
    const mockAnalyzer = makeMockAnalyzer({
      impactResult: { dependents: [], transitive: [] },
    })

    const serviceLayer = editPlannerLayer.pipe(
      Layer.provideMerge(mockRepo),
      Layer.provideMerge(mockAnalyzer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const planner = yield* EditPlanner.Service
        const plan = yield* planner.planBeforeEdit({
          targetSymbol: "myFunction",
          changeKind: "modify",
        })

        const staleRisk = plan.risks.find((r) => r.kind === "stale-graph" && r.severity === "high")
        expect(staleRisk).toBeDefined()
        expect(staleRisk?.message).toContain("30%")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("planBeforeEdit flags broad-impact when transitive > 50", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const transitiveNodes: CodegraphNode[] = Array.from({ length: 60 }, (_, i) => ({
      id: `t${i}`,
      fileID: `f${i}`,
      kind: "function" as const,
      name: `dep${i}`,
      startLine: 1,
      endLine: 5,
    }))

    const mockRepo = makeMockRepo({
      nodes: [targetNode],
      files,
    })
    const mockAnalyzer = makeMockAnalyzer({
      impactResult: { dependents: [testFileNode], transitive: transitiveNodes },
    })

    const serviceLayer = editPlannerLayer.pipe(
      Layer.provideMerge(mockRepo),
      Layer.provideMerge(mockAnalyzer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const planner = yield* EditPlanner.Service
        const plan = yield* planner.planBeforeEdit({
          targetSymbol: "myFunction",
          changeKind: "modify",
        })

        const broadRisk = plan.risks.find((r) => r.kind === "broad-impact")
        expect(broadRisk?.severity).toBe("high")
        expect(broadRisk?.message).toContain("60")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("planBeforeEdit identifies test files for testsToRun", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockRepo = makeMockRepo({
      nodes: [targetNode, testFileNode],
      files,
    })
    const mockAnalyzer = makeMockAnalyzer({
      impactResult: {
        dependents: [testFileNode],
        transitive: [testFileNode],
      },
    })

    const serviceLayer = editPlannerLayer.pipe(
      Layer.provideMerge(mockRepo),
      Layer.provideMerge(mockAnalyzer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const planner = yield* EditPlanner.Service
        const plan = yield* planner.planBeforeEdit({
          targetSymbol: "myFunction",
          changeKind: "modify",
        })

        expect(plan.expectedImpact.testsToRun.some((t) => t.includes("test"))).toBe(true)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("planAfterEdit returns caller-check steps", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockRepo = makeMockRepo({
      nodes: [targetNode, testFileNode],
      files,
    })
    const mockAnalyzer = makeMockAnalyzer({
      callers: [testFileNode],
    })

    const serviceLayer = editPlannerLayer.pipe(
      Layer.provideMerge(mockRepo),
      Layer.provideMerge(mockAnalyzer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const planner = yield* EditPlanner.Service
        const plan = yield* planner.planAfterEdit({
          targetSymbol: "myFunction",
        })

        expect(plan.steps.some((s) => s.tool === "code_find" && s.args.intent === "callers")).toBe(true)
        expect(plan.steps.some((s) => s.tool === "code_find" && s.args.intent === "impact")).toBe(true)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("planAfterEdit flags missing-tests when no test dependents", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const nonTestFile: CodegraphNode = {
      id: "node3",
      fileID: "file3",
      kind: "function",
      name: "otherFunc",
      startLine: 1,
      endLine: 5,
    }

    const mockRepo = makeMockRepo({
      nodes: [targetNode, nonTestFile],
      files: [
        { id: "file1", path: "/src/myFunction.ts", contentHash: "abc", language: "typescript", indexedAt: Date.now() },
        { id: "file3", path: "/src/utils.ts", contentHash: "ghi", language: "typescript", indexedAt: Date.now() },
      ],
    })
    const mockAnalyzer = makeMockAnalyzer({
      callers: [nonTestFile],
    })

    const serviceLayer = editPlannerLayer.pipe(
      Layer.provideMerge(mockRepo),
      Layer.provideMerge(mockAnalyzer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const planner = yield* EditPlanner.Service
        const plan = yield* planner.planAfterEdit({
          targetSymbol: "myFunction",
        })

        const missingTestRisk = plan.risks.find((r) => r.kind === "missing-tests")
        expect(missingTestRisk?.severity).toBe("med")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("planBeforeEdit no stale-graph when graph is fresh", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const justNow = now - 1000 // 1 second ago
    const mockRepo = makeMockRepo({
      nodes: [targetNode],
      files,
      meta: { id: "singleton", graphBuiltAt: justNow, graphCoverage: 0.9, graphVersion: 1, totalFiles: 10, totalNodes: 100, totalEdges: 200, schemaVersion: 1 },
    })
    const mockAnalyzer = makeMockAnalyzer({
      impactResult: { dependents: [], transitive: [] },
    })

    const serviceLayer = editPlannerLayer.pipe(
      Layer.provideMerge(mockRepo),
      Layer.provideMerge(mockAnalyzer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const planner = yield* EditPlanner.Service
        const plan = yield* planner.planBeforeEdit({
          targetSymbol: "myFunction",
          changeKind: "modify",
        })

        const staleRisks = plan.risks.filter((r) => r.kind === "stale-graph")
        expect(staleRisks.length).toBe(0)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

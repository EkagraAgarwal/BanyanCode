import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import {
  RepositoryIntelligence,
  defaultLayer as repositoryIntelligenceDefaultLayer,
} from "../../src/banyancode/repository-intelligence"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(
  repositoryIntelligenceDefaultLayer,
  CodegraphRepo.defaultLayer,
)

describe("Phase 3: diamond graphs return each node exactly once", () => {
  test("BFS deduplicates a diamond where A and B both call C and D", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f-target", path: "src/target.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-a", path: "src/a.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-b", path: "src/b.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-c", path: "src/c.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-d", path: "src/d.ts", contentHash: "h", language: "typescript", indexedAt: 1 })

        yield* repo.putNode({ id: "n-target", fileID: "f-target", kind: "function", name: "target", signature: "t()", startLine: 1, endLine: 2, code: "function target(){}" })
        yield* repo.putNode({ id: "n-a", fileID: "f-a", kind: "function", name: "a", signature: "a()", startLine: 1, endLine: 2, code: "function a(){}" })
        yield* repo.putNode({ id: "n-b", fileID: "f-b", kind: "function", name: "b", signature: "b()", startLine: 1, endLine: 2, code: "function b(){}" })
        yield* repo.putNode({ id: "n-c", fileID: "f-c", kind: "function", name: "c", signature: "c()", startLine: 1, endLine: 2, code: "function c(){}" })
        yield* repo.putNode({ id: "n-d", fileID: "f-d", kind: "function", name: "d", signature: "d()", startLine: 1, endLine: 2, code: "function d(){}" })

        yield* repo.putEdge({ id: "e-a-target", fromNodeID: "n-a", toNodeID: "n-target", kind: "calls" })
        yield* repo.putEdge({ id: "e-b-target", fromNodeID: "n-b", toNodeID: "n-target", kind: "calls" })
        yield* repo.putEdge({ id: "e-c-a", fromNodeID: "n-c", toNodeID: "n-a", kind: "calls" })
        yield* repo.putEdge({ id: "e-d-b", fromNodeID: "n-d", toNodeID: "n-b", kind: "calls" })
        // Diamond edges: c->d and d->c simulate a cycle through shared work.
        yield* repo.putEdge({ id: "e-c-d", fromNodeID: "n-c", toNodeID: "n-d", kind: "calls" })
        yield* repo.putEdge({ id: "e-d-c", fromNodeID: "n-d", toNodeID: "n-c", kind: "calls" })

        const ri = yield* RepositoryIntelligence.Service
        const slc = yield* ri.trace({ symbol: "target", depth: 5 })

        const names = [...slc.directCallers.map((n) => n.name), ...slc.transitiveDependents.map((n) => n.name)]
        // Each node appears exactly once despite the c/d cycle and the
        // multiple paths through a, b, c, d.
        const sorted = [...names].sort()
        expect(sorted).toEqual([...new Set(sorted)].sort())
        // a, b are direct callers (depth 1). c, d are transitive (depth 2).
        expect(slc.directCallers.map((n) => n.name).sort()).toEqual(["a", "b"])
        expect(slc.transitiveDependents.map((n) => n.name).sort()).toEqual(["c", "d"])
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

describe("Phase 3: maxDepth boundary is respected", () => {
  test("maxDepth=1 does not return any depth-2 transitive node", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f-t", path: "src/t.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-1", path: "src/1.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-2", path: "src/2.ts", contentHash: "h", language: "typescript", indexedAt: 1 })

        yield* repo.putNode({ id: "n-t", fileID: "f-t", kind: "function", name: "t", signature: "t()", startLine: 1, endLine: 2, code: "function t(){}" })
        yield* repo.putNode({ id: "n-1", fileID: "f-1", kind: "function", name: "d1", signature: "d1()", startLine: 1, endLine: 2, code: "function d1(){}" })
        yield* repo.putNode({ id: "n-2", fileID: "f-2", kind: "function", name: "d2", signature: "d2()", startLine: 1, endLine: 2, code: "function d2(){}" })

        yield* repo.putEdge({ id: "e1", fromNodeID: "n-1", toNodeID: "n-t", kind: "calls" })
        yield* repo.putEdge({ id: "e2", fromNodeID: "n-2", toNodeID: "n-1", kind: "calls" })

        const ri = yield* RepositoryIntelligence.Service
        const slc = yield* ri.trace({ symbol: "t", depth: 1 })

        expect(slc.directCallers.map((n) => n.name)).toEqual(["d1"])
        expect(slc.transitiveDependents).toEqual([])
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

describe("Phase 4: evidence-based test discovery", () => {
  test("tested_by edge produces derivation=tested_by", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f-sym", path: "src/sym.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-test", path: "src/sym.test.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n-sym", fileID: "f-sym", kind: "function", name: "Sym", signature: "s()", startLine: 1, endLine: 2, code: "function Sym(){}" })
        yield* repo.putNode({ id: "n-test", fileID: "f-test", kind: "test", name: "sym_works", signature: "t()", startLine: 1, endLine: 2, code: "function sym_works(){}" })
        yield* repo.putEdge({ id: "e-tested", fromNodeID: "n-sym", toNodeID: "n-test", kind: "tested_by" })

        const ri = yield* RepositoryIntelligence.Service
        const tests = yield* ri.tests({ symbol: "Sym" })
        expect(tests.tests.some((n) => n.id === "n-test")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("calls edge from test to symbol produces a strong match", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f-sym", path: "src/sym.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-test", path: "src/sym.test.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n-sym", fileID: "f-sym", kind: "function", name: "Sym", signature: "s()", startLine: 1, endLine: 2, code: "function Sym(){}" })
        yield* repo.putNode({ id: "n-test", fileID: "f-test", kind: "test", name: "callsSym", signature: "t()", startLine: 1, endLine: 2, code: "function callsSym(){}" })
        yield* repo.putEdge({ id: "e-calls", fromNodeID: "n-test", toNodeID: "n-sym", kind: "calls" })

        const ri = yield* RepositoryIntelligence.Service
        const tests = yield* ri.tests({ symbol: "Sym" })
        expect(tests.tests.some((n) => n.id === "n-test")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("unrelated test files do NOT match when no graph edge exists", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f-sym", path: "src/sym.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-test", path: "src/sym.test.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n-sym", fileID: "f-sym", kind: "function", name: "Alpha", signature: "a()", startLine: 1, endLine: 2, code: "function Alpha(){}" })
        yield* repo.putNode({ id: "n-test", fileID: "f-test", kind: "test", name: "beta_test", signature: "t()", startLine: 1, endLine: 2, code: "function beta_test(){}" })
        // No edge connects them.

        const ri = yield* RepositoryIntelligence.Service
        const tests = yield* ri.tests({ symbol: "Alpha" })
        expect(tests.tests.find((n) => n.id === "n-test")).toBeUndefined()
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
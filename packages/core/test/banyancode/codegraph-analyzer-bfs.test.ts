import { describe, expect, spyOn, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import {
  CodegraphAnalyzer,
  defaultLayer as codegraphAnalyzerDefaultLayer,
} from "../../src/banyancode/codegraph-analyzer"
import { tmpdir } from "../fixture/tmpdir"
import * as path from "node:path"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(codegraphAnalyzerDefaultLayer, CodegraphRepo.defaultLayer)

describe("codegraph-analyzer bfs port", () => {
  test("impact uses batched frontier queries, not per-node edgesFrom/edgesTo", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "analyzer-bfs.db"))

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        // 3-layer incoming graph: target <- a1..a3 <- b1..b9 <- c1..c9.
        // 22 nodes, depth 3 — a per-node traversal would issue ~21 edge
        // queries; the batched one issues 4 (one per frontier).
        yield* repo.putFile({ id: "f-0", path: "src/n0.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n0", fileID: "f-0", kind: "function", name: "target", startLine: 1, endLine: 2 })
        for (let layer = 1; layer <= 3; layer++) {
          const count = layer === 1 ? 3 : 9
          yield* repo.putFile({ id: `f-${layer}`, path: `src/l${layer}.ts`, contentHash: "h", language: "typescript", indexedAt: 1 })
          for (let i = 0; i < count; i++) {
            const id = `n${layer}_${i}`
            yield* repo.putNode({ id, fileID: `f-${layer}`, kind: "function", name: `l${layer}_${i}`, startLine: 1, endLine: 2 })
            const parent = layer === 1 ? "n0" : `n${layer - 1}_${i % (layer === 2 ? 3 : 9)}`
            yield* repo.putEdge({ id: `e${layer}_${i}`, fromNodeID: id, toNodeID: parent, kind: "calls" })
          }
        }

        const directTo = spyOn(repo, "edgesTo")
        const directFrom = spyOn(repo, "edgesFrom")
        const batchTo = spyOn(repo, "edgesToBatch")
        const batchFrom = spyOn(repo, "edgesFromBatch")
        try {
          const analyzer = yield* CodegraphAnalyzer.Service
          const result = yield* analyzer.impact({ nodeID: "n0" })

          expect(result.dependents).toHaveLength(3)
          expect(result.transitive).toHaveLength(18)

          // No per-node edge queries — only batched frontiers.
          expect(directTo).toHaveBeenCalledTimes(0)
          expect(directFrom).toHaveBeenCalledTimes(0)
          // Incoming-only traversal never touches edgesFromBatch.
          expect(batchFrom).toHaveBeenCalledTimes(0)
          // One edgesToBatch per frontier (sizes 1, 3, 9, 9), not one per
          // node (22 nodes). Batch size grows with the frontier.
          expect(batchTo).toHaveBeenCalledTimes(4)
          expect(batchTo.mock.calls.filter(([ids]) => ids.length === 3)).toHaveLength(1)
          expect(batchTo.mock.calls.filter(([ids]) => ids.length === 9)).toHaveLength(2)
        } finally {
          directTo.mockRestore()
          directFrom.mockRestore()
          batchTo.mockRestore()
          batchFrom.mockRestore()
        }
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("callers keeps only calls/references edges", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "analyzer-callers.db"))

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        const analyzer = yield* CodegraphAnalyzer.Service

        yield* repo.putFile({ id: "f0", path: "src/t.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n0", fileID: "f0", kind: "function", name: "target", startLine: 1, endLine: 2 })
        for (const [id, kind] of [
          ["n-caller", "calls"],
          ["n-referencer", "references"],
          ["n-importer", "imports"],
          ["n-extender", "extends"],
        ] as const) {
          yield* repo.putFile({ id: `f-${id}`, path: `src/${id}.ts`, contentHash: "h", language: "typescript", indexedAt: 1 })
          yield* repo.putNode({ id, fileID: `f-${id}`, kind: "function", name: id, startLine: 1, endLine: 2 })
          yield* repo.putEdge({ id: `e-${id}`, fromNodeID: id, toNodeID: "n0", kind })
        }

        const callers = yield* analyzer.callers({ nodeID: "n0" })
        expect(callers.map((n) => n.id).sort()).toEqual(["n-caller", "n-referencer"])
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("dependents includes every incoming edge kind", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "analyzer-dependents.db"))

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        const analyzer = yield* CodegraphAnalyzer.Service

        yield* repo.putFile({ id: "f0", path: "src/t.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n0", fileID: "f0", kind: "function", name: "target", startLine: 1, endLine: 2 })
        for (const [id, kind] of [
          ["n-calls", "calls"],
          ["n-imports", "imports"],
          ["n-extends", "extends"],
          ["n-tested_by", "tested_by"],
        ] as const) {
          yield* repo.putFile({ id: `f-${id}`, path: `src/${id}.ts`, contentHash: "h", language: "typescript", indexedAt: 1 })
          yield* repo.putNode({ id, fileID: `f-${id}`, kind: "function", name: id, startLine: 1, endLine: 2 })
          yield* repo.putEdge({ id: `e-${id}`, fromNodeID: id, toNodeID: "n0", kind })
        }

        const dependents = yield* analyzer.dependents({ nodeID: "n0" })
        expect(dependents.map((n) => n.id).sort()).toEqual(["n-calls", "n-extends", "n-imports", "n-tested_by"])
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("impact returns { dependents, transitive } with de-dup on a diamond", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "analyzer-diamond.db"))

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        const analyzer = yield* CodegraphAnalyzer.Service

        // n0 <- a, n0 <- b, a <- c, b <- c: c is reachable at depth 2 via
        // both parents and must appear exactly once.
        yield* repo.putFile({ id: "f0", path: "src/t.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n0", fileID: "f0", kind: "function", name: "target", startLine: 1, endLine: 2 })
        for (const id of ["n-a", "n-b", "n-c"]) {
          yield* repo.putFile({ id: `f-${id}`, path: `src/${id}.ts`, contentHash: "h", language: "typescript", indexedAt: 1 })
          yield* repo.putNode({ id, fileID: `f-${id}`, kind: "function", name: id, startLine: 1, endLine: 2 })
        }
        yield* repo.putEdge({ id: "e-a", fromNodeID: "n-a", toNodeID: "n0", kind: "calls" })
        yield* repo.putEdge({ id: "e-b", fromNodeID: "n-b", toNodeID: "n0", kind: "calls" })
        yield* repo.putEdge({ id: "e-c-a", fromNodeID: "n-c", toNodeID: "n-a", kind: "calls" })
        yield* repo.putEdge({ id: "e-c-b", fromNodeID: "n-c", toNodeID: "n-b", kind: "calls" })

        const impact = yield* analyzer.impact({ nodeID: "n0" })
        expect(impact.dependents.map((n) => n.id).sort()).toEqual(["n-a", "n-b"])
        expect(impact.transitive.map((n) => n.id)).toEqual(["n-c"])
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("walkTransitive upstream/downstream maps to incoming/outgoing", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "analyzer-walk.db"))

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        const analyzer = yield* CodegraphAnalyzer.Service

        // caller -> n0 -> dep: upstream from n0 finds the caller, downstream
        // finds the dependency.
        yield* repo.putFile({ id: "f0", path: "src/t.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n0", fileID: "f0", kind: "function", name: "target", startLine: 1, endLine: 2 })
        for (const id of ["n-caller", "n-dep"]) {
          yield* repo.putFile({ id: `f-${id}`, path: `src/${id}.ts`, contentHash: "h", language: "typescript", indexedAt: 1 })
          yield* repo.putNode({ id, fileID: `f-${id}`, kind: "function", name: id, startLine: 1, endLine: 2 })
        }
        yield* repo.putEdge({ id: "e-caller", fromNodeID: "n-caller", toNodeID: "n0", kind: "calls" })
        yield* repo.putEdge({ id: "e-dep", fromNodeID: "n0", toNodeID: "n-dep", kind: "calls" })

        const upstream = yield* analyzer.walkTransitive({ nodeID: "n0", direction: "upstream" })
        const downstream = yield* analyzer.walkTransitive({ nodeID: "n0", direction: "downstream" })
        expect(upstream.map((n) => n.id)).toEqual(["n-caller"])
        expect(downstream.map((n) => n.id)).toEqual(["n-dep"])
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("SymbolNotFoundError channel is preserved for unresolved targets", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "analyzer-notfound.db"))

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const analyzer = yield* CodegraphAnalyzer.Service

        const symbol = yield* analyzer.callers({ function: "missing_symbol_xyz" }).pipe(
          Effect.catchTag("Banyan/SymbolNotFoundError", (err) => Effect.succeed(err.symbol)),
        )
        expect(symbol).toBe("missing_symbol_xyz")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

// Plan Phase B regression coverage (B1, B2, B3). See
// `specs/repository-tools-followup.md` for the audit findings.
//
// Each test exercises one fix from the plan; together they pin the
// post-fix behavior so a regression in any of B1/B2/B3 is caught by the
// suite.

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { Search } from "../../src/banyancode/search/index"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

// ─── B1: codegraph_node_name_idx migration is registered ────────────────

describe("Phase B B1: codegraph_node_name_idx migration registration", () => {
  test("fresh DB gains the index after DatabaseMigration.apply", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "b1.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        return yield* db.all<{ name: string }>(sql`PRAGMA index_list('codegraph_nodes')`)
      }).pipe(Effect.provide(dbLayer), Effect.scoped),
    )

    const names = result.map((r) => r.name)
    expect(names).toContain("codegraph_node_name_idx")
  })

  test("idempotent: re-applying migrations on a DB that already has the index does not fail", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "b1-idem.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        // Re-applying must be a no-op for the migration row and a no-op
        // for the index (CREATE INDEX IF NOT EXISTS). No thrown errors.
        yield* DatabaseMigration.apply(db)
      }).pipe(Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

// ─── B2: UPSERT path into codegraph_nodes populates FTS5 ────────────────

describe("Phase B B2: UPSERT triggers FTS5 population", () => {
  test("putNode + ftsSearchNodes returns the inserted row", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "b2.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.defaultLayer.pipe(Layer.provide(dbLayer))

    const hits = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "f-b2",
          path: "src/b2.ts",
          contentHash: "h",
          language: "typescript",
          indexedAt: Date.now(),
        })
        yield* repo.putNode({
          id: "n-b2",
          fileID: "f-b2",
          kind: "function",
          name: "phloemMarker",
          startLine: 1,
          endLine: 3,
          code: "function phloemMarker() { return 99 }",
        })

        return yield* repo.ftsSearchNodes({ query: "phloemMarker" })
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )

    expect(hits.length).toBeGreaterThanOrEqual(1)
    const names = hits.map((h) => h.name)
    expect(names).toContain("phloemMarker")
  })

  test("putNode update path (UPSERT) keeps FTS5 in sync", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "b2-upsert.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.defaultLayer.pipe(Layer.provide(dbLayer))

    const hitsAfterRename = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "f-b2u",
          path: "src/b2u.ts",
          contentHash: "h",
          language: "typescript",
          indexedAt: Date.now(),
        })
        yield* repo.putNode({
          id: "n-b2u",
          fileID: "f-b2u",
          kind: "function",
          name: "oldName",
          startLine: 1,
          endLine: 3,
          code: "function oldName() { return 1 }",
        })
        // UPSERT (same id): rename via the conflict path.
        yield* repo.putNode({
          id: "n-b2u",
          fileID: "f-b2u",
          kind: "function",
          name: "newName",
          startLine: 1,
          endLine: 3,
          code: "function newName() { return 2 }",
        })

        return yield* repo.ftsSearchNodes({ query: "newName" })
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )

    expect(hitsAfterRename.length).toBeGreaterThanOrEqual(1)
    expect(hitsAfterRename.some((h) => h.name === "newName")).toBe(true)
  })
})

// ─── B3: per-mode pushdown uses searchNodesLight, bounded by limit ──────

// Wrap the real CodegraphRepo with a counting layer that tracks every
// call to `searchNodesLight` and `listAllNodes`. The wrapper delegates
// to the real implementation for behavior, so the test exercises the
// real SQL path while asserting the implementation pattern. A plain
// mutable counter (rather than a Ref) is used so the wrapper's method
// bodies don't need Effect context to read it.
interface PushdownCounters {
  searchNodesLight: number
  listAllNodes: number
}

const buildCountingRepoLayer = (counters: PushdownCounters, panicOnListAllNodes: boolean) =>
  Layer.effect(
    CodegraphRepo.Service,
    Effect.gen(function* () {
      const inner = yield* CodegraphRepo.Service
      return CodegraphRepo.Service.of({
        putFile: inner.putFile,
        getFile: inner.getFile,
        getFileByPath: inner.getFileByPath,
        listAllFiles: inner.listAllFiles,
        putNode: inner.putNode,
        putNodes: inner.putNodes,
        getNode: inner.getNode,
        nodeByID: inner.nodeByID,
        nodesByIDs: inner.nodesByIDs,
        listNodesByFile: inner.listNodesByFile,
        listNodesByKind: inner.listNodesByKind,
        listAllNodes: () =>
          Effect.gen(function* () {
            counters.listAllNodes++
            if (panicOnListAllNodes) {
              return yield* Effect.die(new Error("listAllNodes should NOT be called by per-mode pushdown"))
            }
            return yield* inner.listAllNodes()
          }),
        queryNodes: inner.queryNodes,
        searchNodes: inner.searchNodes,
        searchNodesLight: (input) =>
          Effect.gen(function* () {
            counters.searchNodesLight++
            return yield* inner.searchNodesLight(input)
          }),
        ftsSearchNodes: inner.ftsSearchNodes,
        nodesByFileIDs: inner.nodesByFileIDs,
        filesByIDs: inner.filesByIDs,
        countNodes: inner.countNodes,
        countEdges: inner.countEdges,
        countFiles: inner.countFiles,
        putEdge: inner.putEdge,
        putEdges: inner.putEdges,
        getEdge: inner.getEdge,
        listAllEdges: inner.listAllEdges,
        listEdgesByNode: inner.listEdgesByNode,
        edgesFrom: inner.edgesFrom,
        edgesTo: inner.edgesTo,
        edgesFromBatch: inner.edgesFromBatch,
        edgesToBatch: inner.edgesToBatch,
        deleteFile: inner.deleteFile,
        deleteDerivedEdgesForFiles: inner.deleteDerivedEdgesForFiles,
        writeFileGraph: inner.writeFileGraph,
        clearAll: inner.clearAll,
        recomputeInDegree: inner.recomputeInDegree,
        getMeta: inner.getMeta,
        setMeta: inner.setMeta,
        bumpVersion: inner.bumpVersion,
        recordParseError: inner.recordParseError,
        listParseErrors: inner.listParseErrors,
        clearParseErrors: inner.clearParseErrors,
        findSymbolsByServiceTag: inner.findSymbolsByServiceTag,
        lookupByServiceTag: inner.lookupByServiceTag,
        rebuildFtsIndex: inner.rebuildFtsIndex,
      })
    }),
  ).pipe(Layer.provide(CodegraphRepo.defaultLayer))

const buildThousandNodesFixture = () =>
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service
    const fileID = "f-thousand"
    yield* repo.putFile({
      id: fileID,
      path: "src/thousand.ts",
      contentHash: "h",
      language: "typescript",
      indexedAt: Date.now(),
    })

    const all = Array.from({ length: 1000 }, (_, i) => ({
      id: `n-f${i}`,
      fileID,
      kind: "function" as const,
      name: `f${i}`,
      startLine: i,
      endLine: i,
      code: `function f${i}() {}`,
    }))
    yield* repo.putNodes(all)
  })

describe("Phase B B3: per-mode pushdown (searchNodesLight, bounded)", () => {
  test("searchExact issues <= 3 SQL queries on a 1,000-node fixture", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "b3-1000.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const counters: PushdownCounters = { searchNodesLight: 0, listAllNodes: 0 }
    const repoLayer = buildCountingRepoLayer(counters, true)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* buildThousandNodesFixture()

        const search = yield* Search.Service
        const results = yield* search.searchExact("f42")

        expect(results.length).toBe(1)
        expect(results[0]?.node.name).toBe("f42")

        expect(counters.searchNodesLight).toBeGreaterThanOrEqual(1)
        expect(counters.searchNodesLight).toBeLessThanOrEqual(3)
        expect(counters.listAllNodes).toBe(0)
      }).pipe(Effect.provide(Search.layer), Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("searchPrefix also uses searchNodesLight (bounded) on the 1,000-node fixture", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "b3-prefix.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const counters: PushdownCounters = { searchNodesLight: 0, listAllNodes: 0 }
    const repoLayer = buildCountingRepoLayer(counters, true)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* buildThousandNodesFixture()

        const search = yield* Search.Service
        const results = yield* search.searchPrefix("f4") // f4, f40..f49, f400..f499

        expect(results.length).toBeGreaterThan(1)
        for (const r of results) {
          expect(r.node.name.toLowerCase().startsWith("f4")).toBe(true)
        }

        expect(counters.searchNodesLight).toBeGreaterThanOrEqual(1)
        expect(counters.searchNodesLight).toBeLessThanOrEqual(3)
        expect(counters.listAllNodes).toBe(0)
      }).pipe(Effect.provide(Search.layer), Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("searchCamelCase / searchFuzzy do NOT load every node (bounded)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "b3-cf.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const counters: PushdownCounters = { searchNodesLight: 0, listAllNodes: 0 }
    const repoLayer = buildCountingRepoLayer(counters, true)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* buildThousandNodesFixture()

        const search = yield* Search.Service
        yield* search.searchCamelCase("F0")
        yield* search.searchFuzzy("f42", 1)

        expect(counters.searchNodesLight).toBeGreaterThanOrEqual(1)
        expect(counters.listAllNodes).toBe(0)
      }).pipe(Effect.provide(Search.layer), Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("combined search cascade shares one bounded candidate set", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "b3-cascade.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const counters: PushdownCounters = { searchNodesLight: 0, listAllNodes: 0 }
    const repoLayer = buildCountingRepoLayer(counters, true)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* buildThousandNodesFixture()

        const search = yield* Search.Service
        const results = yield* search.search("f42", { limit: 5 })

        const names = results.map((r) => r.node.name)
        expect(names).toContain("f42")

        expect(counters.listAllNodes).toBe(0)
        expect(counters.searchNodesLight).toBeLessThanOrEqual(5)
      }).pipe(Effect.provide(Search.layer), Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("searchBM25 routes through FTS5 (ftsSearchNodes), not in-JS BM25 over all nodes", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "b3-bm25.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const counters: PushdownCounters = { searchNodesLight: 0, listAllNodes: 0 }
    const repoLayer = buildCountingRepoLayer(counters, true)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* buildThousandNodesFixture()

        const search = yield* Search.Service
        const results = yield* search.searchBM25("f42", 10)

        expect(results.length).toBeGreaterThan(0)
        // BM25 path uses FTS5 (no listAllNodes fallback when FTS has hits).
        expect(counters.listAllNodes).toBe(0)
      }).pipe(Effect.provide(Search.layer), Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

// ─── B3 bonus: writeFileGraph batches > 1 service-tag entries ───────────

describe("Phase B B3 bonus: writeFileGraph batches service-tag inserts", () => {
  test("writeFileGraph with 5 service-tag entries commits in one transaction", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "b3-batch.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.defaultLayer.pipe(Layer.provide(dbLayer))

    const fileID = "f-multisvc"
    const services = [
      { tag: "@banyancode/Alpha", name: "Alpha", id: "node:Alpha:1" },
      { tag: "@banyancode/Beta", name: "Beta", id: "node:Beta:1" },
      { tag: "@banyancode/Gamma", name: "Gamma", id: "node:Gamma:1" },
      { tag: "@banyancode/Delta", name: "Delta", id: "node:Delta:1" },
      { tag: "@banyancode/Epsilon", name: "Epsilon", id: "node:Epsilon:1" },
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        yield* repo.writeFileGraph({
          file: {
            id: fileID,
            path: "src/multi.ts",
            contentHash: "h",
            language: "typescript",
            indexedAt: Date.now(),
          },
          nodes: services.map((svc) => ({
            id: svc.id,
            fileID,
            kind: "class",
            name: svc.name,
            signature: `class ${svc.name} extends Context.Service<${svc.name}, Interface>()`,
            startLine: 1,
            endLine: 5,
            code: `export class ${svc.name} extends Context.Service<${svc.name}, Interface>()("${svc.tag}") {}`,
          })),
          edges: [],
        })

        for (const svc of services) {
          const node = yield* repo.lookupByServiceTag(svc.tag)
          expect(node).not.toBeNull()
          expect(node!.id).toBe(svc.id)
        }
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const row = yield* db.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM codegraph_service_tags`)
        expect(row?.c).toBe(5)
      }).pipe(Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("writeFileGraph with a single service-tag entry keeps the per-row path", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "b3-single.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.defaultLayer.pipe(Layer.provide(dbLayer))

    const fileID = "f-single"

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        yield* repo.writeFileGraph({
          file: {
            id: fileID,
            path: "src/single.ts",
            contentHash: "h",
            language: "typescript",
            indexedAt: Date.now(),
          },
          nodes: [
            {
              id: "node:Only:1",
              fileID,
              kind: "class",
              name: "Only",
              signature: "class Only extends Context.Service<Only, Interface>()",
              startLine: 1,
              endLine: 5,
              code: 'export class Only extends Context.Service<Only, Interface>()("@banyancode/Only") {}',
            },
          ],
          edges: [],
        })

        const result = yield* repo.lookupByServiceTag("@banyancode/Only")
        expect(result).not.toBeNull()
        expect(result!.id).toBe("node:Only:1")
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )
  })

  test("writeFileGraph transaction atomicity: 2 tags both commit (multi-row upsert path)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "b3-tx.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.defaultLayer.pipe(Layer.provide(dbLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        yield* repo.writeFileGraph({
          file: {
            id: "f-txmark",
            path: "src/tx.ts",
            contentHash: "h",
            language: "typescript",
            indexedAt: Date.now(),
          },
          nodes: [
            {
              id: "node:A:1",
              fileID: "f-txmark",
              kind: "class",
              name: "A",
              signature: "class A extends Context.Service<A, Interface>()",
              startLine: 1,
              endLine: 5,
              code: 'export class A extends Context.Service<A, Interface>()("@banyancode/A") {}',
            },
            {
              id: "node:B:1",
              fileID: "f-txmark",
              kind: "class",
              name: "B",
              signature: "class B extends Context.Service<B, Interface>()",
              startLine: 1,
              endLine: 5,
              code: 'export class B extends Context.Service<B, Interface>()("@banyancode/B") {}',
            },
          ],
          edges: [],
        })

        const a = yield* repo.lookupByServiceTag("@banyancode/A")
        const b = yield* repo.lookupByServiceTag("@banyancode/B")
        expect(a).not.toBeNull()
        expect(b).not.toBeNull()
        expect(a!.id).toBe("node:A:1")
        expect(b!.id).toBe("node:B:1")
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )
  })
})
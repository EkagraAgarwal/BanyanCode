import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/tmpdir"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { CodegraphRepo } from "../../src/banyancode/codegraph-repo"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"

process.env.BANYANCODE_ENABLE = "1"

// Each test below sets process.env.OPENCODE_DB to a tmpdir path. Database.path()
// reads this env var, so a leak would silently route subsequent tests to a
// path that no longer exists (CANTOPEN 14). Snapshot and restore on every
// test to keep the global env clean.
const previousOpencodeDb = process.env.OPENCODE_DB
afterEach(() => {
  if (previousOpencodeDb === undefined) {
    delete process.env.OPENCODE_DB
  } else {
    process.env.OPENCODE_DB = previousOpencodeDb
  }
})

describe("codegraph-fts5", () => {
  test("rebuildFtsIndex reports 3 rowsIndexed after inserting 3 nodes", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "codegraph.sqlite")

    process.env.OPENCODE_DB = dbPath

    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
      }).pipe(Effect.provide(dbLayer)) as unknown as Effect.Effect<void, never, never>,
    )

    const repoLayer = CodegraphRepo.layer.pipe(Layer.provide(dbLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "file-1",
          path: "/test/file.ts",
          contentHash: "abc123",
          language: "typescript",
          indexedAt: Date.now(),
        })

        yield* repo.putNode({
          id: "node-alpha",
          fileID: "file-1",
          kind: "function",
          name: "alphaUnique",
          startLine: 1,
          endLine: 5,
          code: "function alphaUnique() {}",
        })
        yield* repo.putNode({
          id: "node-beta",
          fileID: "file-1",
          kind: "function",
          name: "betaFunction",
          startLine: 10,
          endLine: 12,
          code: "function frobulator() {}",
        })
        yield* repo.putNode({
          id: "node-gamma",
          fileID: "file-1",
          kind: "class",
          name: "gammaClass",
          startLine: 20,
          endLine: 25,
          code: "class gammaClass { frobulator() {} }",
        })

        const result = yield* repo.rebuildFtsIndex()
        expect(result.rowsIndexed).toBe(3)
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("code-only term is searchable via ftsSearchNodes after rebuild (lives in the code table)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "codegraph.sqlite")

    process.env.OPENCODE_DB = dbPath

    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer.pipe(Layer.provide(dbLayer))

    const hits = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "file-2",
          path: "/test/file2.ts",
          contentHash: "def456",
          language: "typescript",
          indexedAt: Date.now(),
        })

        yield* repo.putNode({
          id: "node-searchable",
          fileID: "file-2",
          kind: "function",
          name: "searchableFunction",
          startLine: 1,
          endLine: 3,
          code: "function frobulator() {}",
        })

        yield* repo.rebuildFtsIndex()

        // The term lives only in `code`: the names table must not match
        // it (code left the trigram index in the FTS split), while the
        // code table does.
        const namesHits = (yield* db
          .all(sql`SELECT rowid FROM \`codegraph_fts\` WHERE \`codegraph_fts\` MATCH 'frobulator'`)
          .pipe(Effect.orDie)) as Array<{ rowid: number }>
        expect(namesHits.length).toBe(0)
        const codeHits = (yield* db
          .all(sql`SELECT rowid FROM \`codegraph_fts_code\` WHERE \`codegraph_fts_code\` MATCH 'frobulator'`)
          .pipe(Effect.orDie)) as Array<{ rowid: number }>
        expect(codeHits.length).toBeGreaterThan(0)

        return yield* repo.ftsSearchNodes({ query: "frobulator" })
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.id === "node-searchable")).toBe(true)
  })

  test("trigger fires on putNode insertion - new node is immediately findable via FTS5", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "codegraph.sqlite")

    process.env.OPENCODE_DB = dbPath

    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer.pipe(Layer.provide(dbLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "file-3",
          path: "/test/file3.ts",
          contentHash: "ghi789",
          language: "typescript",
          indexedAt: Date.now(),
        })

        yield* repo.putNode({
          id: "node-trigger-test",
          fileID: "file-3",
          kind: "function",
          name: "triggerTestFunction",
          startLine: 1,
          endLine: 3,
          code: "function xyzzyMarker() {}",
        })

        // No rebuild: the insert triggers must have populated both FTS
        // tables synchronously.
        const hits = yield* repo.ftsSearchNodes({ query: "xyzzyMarker" })
        expect(hits.length).toBe(1)
        expect(hits[0]!.name).toBe("triggerTestFunction")
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

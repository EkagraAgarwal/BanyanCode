import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/tmpdir"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { CodegraphRepo } from "../../src/banyancode/codegraph-repo"
import { Database } from "@opencode-ai/core/database/database"
import ftsMigration from "../../src/database/migration/20260707120000_codegraph_fts"

process.env.BANYANCODE_ENABLE = "1"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const applyFtsMigration = (db: any) =>
  Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    const completed = new Set(
      (yield* db.all(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row: { id: string }) => row.id),
    )
    if (!completed.has(ftsMigration.id)) {
      yield* db.transaction((tx: any) =>
        Effect.gen(function* () {
          yield* ftsMigration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES(${ftsMigration.id}, ${Date.now()})`,
          )
        }),
      )
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
        yield* applyFtsMigration(db)
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
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )
  })

  test("FTS5 table is queryable via raw SQL after rebuild", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "codegraph.sqlite")

    process.env.OPENCODE_DB = dbPath

    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* applyFtsMigration(db)
      }).pipe(Effect.provide(dbLayer)) as unknown as Effect.Effect<void, never, never>,
    )

    const repoLayer = CodegraphRepo.layer.pipe(Layer.provide(dbLayer))

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
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
        return yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          const result = yield* db
            .all(sql`SELECT name FROM \`codegraph_fts\` WHERE \`codegraph_fts\` MATCH 'frobulator'`)
            .pipe(Effect.orDie)
          return result as Array<{ name: string }>
        }).pipe(Effect.provide(dbLayer))
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )

    expect(rows.length).toBeGreaterThan(0)
  })

  test("trigger fires on putNode insertion - new node is immediately findable via FTS5", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "codegraph.sqlite")

    process.env.OPENCODE_DB = dbPath

    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* applyFtsMigration(db)
      }).pipe(Effect.provide(dbLayer)) as unknown as Effect.Effect<void, never, never>,
    )

    const repoLayer = CodegraphRepo.layer.pipe(Layer.provide(dbLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
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

        const rows = yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          return yield* db
            .all(sql`SELECT name FROM \`codegraph_fts\` WHERE \`codegraph_fts\` MATCH 'xyzzyMarker'`)
            .pipe(Effect.orDie)
        }).pipe(Effect.provide(dbLayer))

        expect(rows.length).toBe(1)
        const row = rows[0] as { name: string }
        expect(row.name).toBe("triggerTestFunction")
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )
  })
})
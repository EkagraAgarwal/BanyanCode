import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { migrations } from "../../src/database/migration.gen"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const previousOpencodeDb = process.env.OPENCODE_DB
const previousSkipMigrations = process.env.OPENCODE_SKIP_MIGRATIONS
afterEach(() => {
  if (previousOpencodeDb === undefined) {
    delete process.env.OPENCODE_DB
  } else {
    process.env.OPENCODE_DB = previousOpencodeDb
  }
  if (previousSkipMigrations === undefined) {
    delete process.env.OPENCODE_SKIP_MIGRATIONS
  } else {
    process.env.OPENCODE_SKIP_MIGRATIONS = previousSkipMigrations
  }
})

const SPLIT_ID = "20261002120000_codegraph_fts_split"
const testLayer = Layer.mergeAll(CodegraphRepo.defaultLayer)
// Realistic code-heavy bodies: varied identifiers per line (like real
// source), not one repeated filler — repetition collapses distinct-term
// counts and hides the trigram blowup being measured. Every body also
// carries the whole-word marker `uniquecodemarkertoken`, which appears
// in NO name or signature.
const seedCodeHeavy = (repo: CodegraphRepo.Interface, count: number, bodyKB: number) =>
  Effect.gen(function* () {
    yield* repo.putFile({ id: "f", path: "/test/big.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
    for (let i = 0; i < count; i++) {
      const lines: string[] = [`function heavyFunction${i}(input${i}Payload: Payload${i}Kind) {`]
      const reps = Math.ceil((bodyKB * 1024) / 64)
      for (let j = 0; j < reps; j++) {
        lines.push(
          `  const transformed${i}Value${j} = normalize${j}Input(input${i}Payload, default${i}Config${j}) + "suffix${i}x${j}";`,
        )
      }
      lines.push(`  return transformed${i}Value0; // uniquecodemarkertoken\n}`)
      yield* repo.putNode({
        id: `n${i}`,
        fileID: "f",
        kind: "function",
        name: `heavyFunction${i}`,
        signature: `heavyFunction${i}(input${i}Payload: Payload${i}Kind)`,
        startLine: i * 100,
        endLine: i * 100 + 99,
        code: lines.join("\n"),
      })
    }
  })

describe("FTS split — trigram(names) + unicode61(code)", () => {
  test("code-only term leaves the trigram table but stays findable", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const hits = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* seedCodeHeavy(repo, 5, 4)
        yield* repo.rebuildFtsIndex()

        // Structural: the code-only marker is indexed in the code table
        // and NOT in the trigram names table.
        const namesHits = (yield* db
          .all(sql`SELECT rowid FROM \`codegraph_fts\` WHERE \`codegraph_fts\` MATCH 'uniquecodemarkertoken'`)
          .pipe(Effect.orDie)) as Array<{ rowid: number }>
        expect(namesHits.length).toBe(0)
        const codeHits = (yield* db
          .all(sql`SELECT rowid FROM \`codegraph_fts_code\` WHERE \`codegraph_fts_code\` MATCH 'uniquecodemarkertoken'`)
          .pipe(Effect.orDie)) as Array<{ rowid: number }>
        expect(codeHits.length).toBe(5)

        // Behavioral: name queries keep working (partial trigram match
        // on the names table) and the code-only term is still recalled.
        const nameHits = yield* repo.ftsSearchNodes({ query: "heavyFunction", limit: 10 })
        expect(nameHits.length).toBe(5)
        return yield* repo.ftsSearchNodes({ query: "uniquecodemarkertoken", limit: 10 })
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(hits.length).toBe(5)
  })

  test("camelCase identifier typed from code stays findable via the whole-piece term", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const hits = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* repo.putFile({ id: "f", path: "/test/a.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        // The camelCase marker lives ONLY in code, under an unrelated name.
        yield* repo.putNode({
          id: "n1",
          fileID: "f",
          kind: "function",
          name: "unrelatedName",
          startLine: 1,
          endLine: 3,
          code: "function unrelatedName() { return xyzzyPlughMarker; }",
        })
        return yield* repo.ftsSearchNodes({ query: "xyzzyPlughMarker" })
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(hits.length).toBe(1)
    expect(hits[0]!.id).toBe("n1")
  })

  test("FTS footprint shrinks vs the pre-split trigram-everything schema", async () => {
    // NOTE: OPENCODE_SKIP_MIGRATIONS must be set before runPromise —
    // layerFromPath's open() runs the full migration set when the layer
    // builds. With SKIP set, open() records the journal without running
    // any migration; the effect body then clears the journal, unsets
    // SKIP, and applies only the pre-split set for real.
    const seedAndMeasure = (skipSplit: boolean) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        if (skipSplit) {
          yield* db.run(sql`DELETE FROM migration`)
          delete process.env.OPENCODE_SKIP_MIGRATIONS
          yield* DatabaseMigration.applyOnly(
            db,
            migrations.filter((m) => m.id !== SPLIT_ID),
          )
        } else {
          yield* DatabaseMigration.apply(db)
        }
        const repo = yield* CodegraphRepo.Service
        yield* seedCodeHeavy(repo, 60, 8)
        if (!skipSplit) yield* repo.rebuildFtsIndex()
        yield* db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`)
        const rows = (yield* db.all(
          sql`SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name LIKE 'codegraph_fts%'`,
        )) as Array<{ bytes: number | null }>
        return rows[0]?.bytes ?? 0
      })

    await using oldTmp = await tmpdir()
    const oldDbLayer = Database.layerFromPath(path.join(oldTmp.path, "old.sqlite"))
    process.env.OPENCODE_SKIP_MIGRATIONS = "1"
    let oldBytes = 0
    try {
      oldBytes = await Effect.runPromise(
        seedAndMeasure(true).pipe(Effect.provide(testLayer), Effect.provide(oldDbLayer), Effect.scoped),
      )
    } finally {
      delete process.env.OPENCODE_SKIP_MIGRATIONS
    }

    await using newTmp = await tmpdir()
    const newDbLayer = Database.layerFromPath(path.join(newTmp.path, "new.sqlite"))
    const newBytes = await Effect.runPromise(
      seedAndMeasure(false).pipe(Effect.provide(testLayer), Effect.provide(newDbLayer), Effect.scoped),
    )

    // Measured ~0.41x on this fixture (2.0 MB vs 5.0 MB FTS for 60x8 KB
    // of varied code); 0.6 leaves headroom for tokenizer/page-size drift
    // across SQLite builds while still catching a trigram-code regression.
    expect(newBytes).toBeGreaterThan(0)
    expect(newBytes).toBeLessThan(oldBytes * 0.6)
  })
})

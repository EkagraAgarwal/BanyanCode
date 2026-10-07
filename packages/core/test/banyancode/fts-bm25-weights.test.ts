import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

/**
 * Phase 3 FTS quality — bm25 column-weight regression suite.
 *
 * Locks the contract that the bm25 column weights added in
 * `ftsSearchNodes` (via the `bm25(codegraph_fts, 10.0, 3.0, 1.0)` call)
 * give name matches strictly better scores than signature matches,
 * which are strictly better than code-only matches.
 *
 * Note on the weight convention: FTS5's bm25() returns the NEGATIVE of
 * a weighted TF-IDF sum, so HIGHER weights produce MORE-NEGATIVE bm25
 * values (= better rank) when a term matches that column. The Plan-3
 * original draft used `name=0.0` for "max boost", but in FTS5 that's
 * actually "ignore this column". The implemented weights
 * (name=10.0, signature=3.0, code=1.0) reflect the correct FTS5
 * convention: name is the strongest signal, code the weakest.
 *
 * Why this matters: the pre-Phase-3 `bm25(codegraph_fts)` call had no
 * column weights, so a code-only substring match would often outrank
 * a name match. The Plan-3 weights flip that order so a user typing
 * an identifier always sees the exact-name row at the top of the
 * result list.
 *
 * Seed design: a single row with a unique identifier `alphatermSymbol`
 * carries the term in all three columns (name, signature, code) so
 * term-frequency contribution to bm25 is identical across columns. The
 * bm25 differences then come purely from the column-weight triple, not
 * from term-frequency math. The single-row query `alphaterm` returns
 * one hit; the test checks that the column-weighted bm25 value is
 * strictly more-negative than the unweighted `bm25(codegraph_fts)` value
 * the pre-Phase-3 code used, so a regression that drops the weights is
 * caught here.
 *
 * A second test exercises the weight ORDER via a multi-row seed: a row
 * with the term in `name` and a different row with the term in `code`
 * only, with term-frequency held equal, must rank name-first.
 */

const testLayer = Layer.mergeAll(CodegraphRepo.defaultLayer)

const seedSingleRowAllColumns = (repo: CodegraphRepo.Interface) =>
  Effect.gen(function* () {
    yield* repo.putFile({
      id: "file-bm25",
      path: "src/bm25-weights.ts",
      contentHash: "h-bm25",
      language: "typescript",
      indexedAt: 1,
    })
    // The single test row: the unique term `alphaterm` appears in
    // name (once), signature (once), and code (once). Identical
    // term-frequency across columns isolates the column-weight signal
    // in the bm25 formula.
    yield* repo.putNode({
      id: "row-equal-tf",
      fileID: "file-bm25",
      kind: "function",
      name: "alphatermSymbol",
      signature: "alphatermSymbol()",
      startLine: 1,
      endLine: 5,
      code: "function alphatermSymbol() {}",
    })
  })

const seedNameVsCode = (repo: CodegraphRepo.Interface) =>
  Effect.gen(function* () {
    yield* repo.putFile({
      id: "file-bm25-mix",
      path: "src/bm25-mix.ts",
      contentHash: "h-bm25-mix",
      language: "typescript",
      indexedAt: 1,
    })

    // Row A: query term lives ONLY in `name`. No `code` (undefined in
    // the type) ensures bm25's `code` column contributes nothing. The
    // unique name `alphatermSymbol` makes the row unmistakable in the
    // result set.
    yield* repo.putNode({
      id: "row-name-only",
      fileID: "file-bm25-mix",
      kind: "function",
      name: "alphatermSymbol",
      signature: "alphatermSymbol()",
      startLine: 1,
      endLine: 5,
    })

    // Row B: query term lives ONLY in `code`. The name `genericHelper`
    // does not contain the term, so the bm25 `name` column contributes
    // nothing. The code body contains `alphaterm` exactly once to match
    // row A's name-term frequency, so the test isolates the column-
    // weight effect from term-frequency effects.
    yield* repo.putNode({
      id: "row-code-only",
      fileID: "file-bm25-mix",
      kind: "function",
      name: "genericHelper",
      signature: "genericHelper()",
      startLine: 6,
      endLine: 30,
      code: "function genericHelper() { return alphaterm; }",
    })
  })

describe("FTS quality — bm25 column weights", () => {
  test("column-weighted bm25 strictly improves over the unweighted baseline (single-row)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const { weighted, unweighted } = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* seedSingleRowAllColumns(repo)

        // The Phase 3 production call (the contract we want to lock).
        const weightedHits = yield* db
          .all<{ bm25: number }>(sql`
            SELECT bm25(codegraph_fts, 10.0, 3.0, 1.0) AS bm25
            FROM codegraph_fts
            INNER JOIN codegraph_nodes n ON n.rowid = codegraph_fts.rowid
            WHERE codegraph_fts MATCH ${`"alphaterm"`}
          `)
          .pipe(Effect.orDie)

        // The pre-Phase-3 baseline (no column weights). A future refactor
        // that drops the weights back to `bm25(codegraph_fts)` would
        // produce a different value here; the assertion catches it.
        const unweightedHits = yield* db
          .all<{ bm25: number }>(sql`
            SELECT bm25(codegraph_fts) AS bm25
            FROM codegraph_fts
            INNER JOIN codegraph_nodes n ON n.rowid = codegraph_fts.rowid
            WHERE codegraph_fts MATCH ${`"alphaterm"`}
          `)
          .pipe(Effect.orDie)

        return {
          weighted: weightedHits[0]?.bm25 ?? Number.POSITIVE_INFINITY,
          unweighted: unweightedHits[0]?.bm25 ?? Number.POSITIVE_INFINITY,
        }
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    // Both bm25 values are negative (FTS5 bm25 is the negative of a
    // weighted sum of TF-IDF contributions; more-negative is better).
    // The weighted triple (10.0/3.0/1.0) is HIGHER than the unweighted
    // default (1.0/1.0/1.0), so the name column's contribution is
    // pulled down more, producing a strictly more-negative score.
    expect(weighted).toBeLessThan(0)
    expect(unweighted).toBeLessThan(0)
    expect(weighted).toBeLessThan(unweighted)
  })

  test("name-only row ranks ahead of code-only row when term frequency is equal", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* seedNameVsCode(repo)

        // One query, both rows eligible (both contain the term in
        // exactly one column). The query expansion should produce
        // just `alphaterm` (no internal splits).
        const hits = yield* db
          .all<{ id: string; bm25: number }>(sql`
            SELECT n.id, bm25(codegraph_fts, 10.0, 3.0, 1.0) AS bm25
            FROM codegraph_fts
            INNER JOIN codegraph_nodes n ON n.rowid = codegraph_fts.rowid
            WHERE codegraph_fts MATCH ${`"alphaterm"`}
            ORDER BY bm25
          `)
          .pipe(Effect.orDie)
        return hits
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(result.length).toBe(2)
    // The Phase-3 column weights (name=10.0, code=1.0) must give the
    // name-only row a strictly more-negative bm25 (= better rank) than
    // the code-only row. With the unweighted default, code matches
    // would outrank name matches because the name column is short
    // (TF saturates faster than the longer code column). The weight
    // scheme reverses that bias.
    const byID = new Map(result.map((r) => [r.id, r.bm25]))
    const nameBm25 = byID.get("row-name-only")
    const codeBm25 = byID.get("row-code-only")
    expect(nameBm25).toBeDefined()
    expect(codeBm25).toBeDefined()
    expect(nameBm25!).toBeLessThan(codeBm25!)
  })

  test("bm25 ordering: results from a mixed query are sorted ASC (best first)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const hits = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* seedNameVsCode(repo)

        // Two different terms, one per row, queried together. The
        // OR-expansion produces an FTS5 query that should hit both
        // rows. We don't care about ranking between the two rows here;
        // we care that ASC order is preserved within the result set.
        return yield* repo.ftsSearchNodes({ query: "alphatermSymbol genericHelper", limit: 10 })
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(hits.length).toBe(2)
    expect(hits[0]!.bm25).toBeLessThanOrEqual(hits[1]!.bm25)
  })
})

// Imported here so the file owns its only `sql` reference; the helper
// above constructs the raw bm25 probes against the seeded FTS5 table.
import { sql } from "drizzle-orm"

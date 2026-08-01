import { Cause, Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

// Phase 3: Rich FTS quality — trigram tokenizer + `signature` column + bm25 weights.
//
// Replaces the `unicode61 remove_diacritics 2` FTS5 table created in
// 20260707120000_codegraph_fts with one that:
//   1. Uses the FTS5 `trigram` tokenizer (SQLite 3.34+ / libsql 0.10+).
//      trigram indexes all 3-character substrings of every token, so partial
//      identifier queries like `codegraph` hit `CodegraphBuildService`
//      without requiring a separate prefix-index.
//   2. Adds a `signature` column so method signatures (which carry argument
//      types and names but rarely a `code` body in the indexer output) are
//      searchable. A query for `bumpVersion` now finds `bumpVersion()`
//      methods that live only in the signature column.
//   3. Sets up the column-order contract `ftsSearchNodes` relies on:
//      `bm25(codegraph_fts, <name>, <signature>, <code>)`. Weights are
//      picked at query time; this migration only fixes the column order.
//
// Trigram support is probed at migration time. If the runtime SQLite does
// not advertise it (older libsql binary, system sqlite < 3.34, or a
// strict FTS5 build that omits the trigram helper), the migration logs a
// warning to stderr and falls back to `unicode61 remove_diacritics 2` so
// cold-start never throws. The plan calls for this fallback to preserve
// the old ranking until trigram is available.
//
// Drops + recreates the three content-sync triggers so they reference
// the new `name, signature, code` column set instead of the old
// `name, code` pair. Backfills from `codegraph_nodes` after recreation.
export default {
  id: "20260801120000_codegraph_fts_tokenize",
  up(tx) {
    // Effect v4 beta ships without `catchAll` — use `catchCause` for
    // catch-all error handling. See AGENTS.md "Effect v4 beta" lesson.
    return Effect.gen(function* () {
      const trigramSupported: boolean = yield* Effect.gen(function* () {
        yield* tx.run(
          sql`CREATE VIRTUAL TABLE __banyan_fts_trigram_probe__ USING fts5(x, tokenize='trigram')`,
        )
        yield* tx.run(sql`DROP TABLE __banyan_fts_trigram_probe__`)
        return true
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* tx
              .run(sql`DROP TABLE IF EXISTS __banyan_fts_trigram_probe__`)
              .pipe(Effect.catchCause(() => Effect.void))
            process.stderr.write(
              `[codegraph_fts_tokenize] trigram tokenizer unavailable; ` +
                `falling back to unicode61 remove_diacritics 2. Cause: ${Cause.pretty(cause)}\n` +
                "Partial identifier queries will be noisier until the runtime SQLite is upgraded.\n",
            )
            return false
          }),
        ),
      )

      yield* tx.run(sql`DROP TRIGGER IF EXISTS \`codegraph_fts_insert\``)
      yield* tx.run(sql`DROP TRIGGER IF EXISTS \`codegraph_fts_delete\``)
      yield* tx.run(sql`DROP TRIGGER IF EXISTS \`codegraph_fts_update\``)
      yield* tx.run(sql`DROP TABLE IF EXISTS \`codegraph_fts\``)

      if (trigramSupported) {
        yield* tx.run(sql`
          CREATE VIRTUAL TABLE \`codegraph_fts\` USING fts5(
            \`name\`,
            \`signature\`,
            \`code\`,
            content='codegraph_nodes',
            content_rowid='rowid',
            tokenize='trigram'
          )
        `)
      } else {
        yield* tx.run(sql`
          CREATE VIRTUAL TABLE \`codegraph_fts\` USING fts5(
            \`name\`,
            \`signature\`,
            \`code\`,
            content='codegraph_nodes',
            content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
          )
        `)
      }

      yield* tx.run(sql`
        CREATE TRIGGER \`codegraph_fts_insert\` AFTER INSERT ON \`codegraph_nodes\` BEGIN
          INSERT INTO \`codegraph_fts\`(\`rowid\`, \`name\`, \`signature\`, \`code\`)
          VALUES (new.\`rowid\`, new.\`name\`, COALESCE(new.\`signature\`, ''), COALESCE(new.\`code\`, ''));
        END
      `)

      yield* tx.run(sql`
        CREATE TRIGGER \`codegraph_fts_delete\` AFTER DELETE ON \`codegraph_nodes\` BEGIN
          INSERT INTO \`codegraph_fts\`(\`codegraph_fts\`, \`rowid\`, \`name\`, \`signature\`, \`code\`)
          VALUES('delete', old.\`rowid\`, old.\`name\`, COALESCE(old.\`signature\`, ''), COALESCE(old.\`code\`, ''));
        END
      `)

      yield* tx.run(sql`
        CREATE TRIGGER \`codegraph_fts_update\` AFTER UPDATE ON \`codegraph_nodes\` BEGIN
          INSERT INTO \`codegraph_fts\`(\`codegraph_fts\`, \`rowid\`, \`name\`, \`signature\`, \`code\`)
          VALUES('delete', old.\`rowid\`, old.\`name\`, COALESCE(old.\`signature\`, ''), COALESCE(old.\`code\`, ''));
          INSERT INTO \`codegraph_fts\`(\`rowid\`, \`name\`, \`signature\`, \`code\`)
          VALUES (new.\`rowid\`, new.\`name\`, COALESCE(new.\`signature\`, ''), COALESCE(new.\`code\`, ''));
        END
      `)

      yield* tx.run(sql`
        INSERT INTO \`codegraph_fts\`(\`rowid\`, \`name\`, \`signature\`, \`code\`)
        SELECT \`rowid\`, \`name\`, COALESCE(\`signature\`, ''), COALESCE(\`code\`, '')
        FROM \`codegraph_nodes\`
      `)
    })
  },
} satisfies DatabaseMigration.Migration

import { Cause, Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

// Split FTS: trigram(name, signature) + unicode61(code).
//
// Why: `codegraph_fts_data` reached 308 MB in one production DB — larger
// than nodes + edges combined. The root cause is the FTS5 `trigram`
// tokenizer over the full `code` column: trigram indexes every
// 3-character substring of every token, so long code bodies explode the
// inverted index roughly 5-10x versus whole-token indexing. Names and
// signatures are short, so trigram stays affordable there AND keeps the
// partial-identifier contract (`build` matches `CodegraphBuildService`,
// pinned by fts-tokenize.test.ts). Code bodies move to a second FTS5
// table with the `unicode61` tokenizer (one index entry per token),
// which preserves whole-identifier code search (`frobulator`,
// `Effect.gen` use-sites) at a fraction of the size. Consciously
// dropped: infix-substring matches inside code bodies (e.g. query
// `covery` matching `recovery` in code). Name/signature infix matching
// is unchanged.
//
// Also drops the dead `codegraph_nodes_fts` table (+ its three triggers)
// created by 20260621120000_libsql_fresh: nothing queries it, but its
// triggers fire on every node write.
//
// `ftsSearchNodes` (codegraph-repo.ts) queries both tables and merges
// with name/signature hits ranked ahead of code-only hits — the same
// order the old `bm25(codegraph_fts, 10.0, 3.0, 1.0)` weights produced.
//
// Idempotent: every DROP uses IF EXISTS and both FTS tables are
// recreated from scratch, so re-running converges to the same schema.
// Backfill is chunked by rowid so a large `codegraph_nodes` table does
// not build either index in a single statement.
export default {
  id: "20261002120000_codegraph_fts_split",
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
              `[codegraph_fts_split] trigram tokenizer unavailable; ` +
                `falling back to unicode61 remove_diacritics 2 for names. Cause: ${Cause.pretty(cause)}\n` +
                "Partial identifier queries will be noisier until the runtime SQLite is upgraded.\n",
            )
            return false
          }),
        ),
      )

      // Drop sync triggers first so no write lands in a half-migrated index.
      yield* tx.run(sql`DROP TRIGGER IF EXISTS \`codegraph_fts_insert\``)
      yield* tx.run(sql`DROP TRIGGER IF EXISTS \`codegraph_fts_delete\``)
      yield* tx.run(sql`DROP TRIGGER IF EXISTS \`codegraph_fts_update\``)
      yield* tx.run(sql`DROP TABLE IF EXISTS \`codegraph_fts\``)
      // Dead table from 20260621120000_libsql_fresh — nothing reads it,
      // but its triggers fire on every node write.
      yield* tx.run(sql`DROP TRIGGER IF EXISTS \`codegraph_nodes_ai\``)
      yield* tx.run(sql`DROP TRIGGER IF EXISTS \`codegraph_nodes_ad\``)
      yield* tx.run(sql`DROP TRIGGER IF EXISTS \`codegraph_nodes_au\``)
      yield* tx.run(sql`DROP TABLE IF EXISTS \`codegraph_nodes_fts\``)
      yield* tx.run(sql`DROP TRIGGER IF EXISTS \`codegraph_fts_code_insert\``)
      yield* tx.run(sql`DROP TRIGGER IF EXISTS \`codegraph_fts_code_delete\``)
      yield* tx.run(sql`DROP TRIGGER IF EXISTS \`codegraph_fts_code_update\``)
      yield* tx.run(sql`DROP TABLE IF EXISTS \`codegraph_fts_code\``)

      if (trigramSupported) {
        yield* tx.run(sql`
          CREATE VIRTUAL TABLE \`codegraph_fts\` USING fts5(
            \`name\`,
            \`signature\`,
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
            content='codegraph_nodes',
            content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
          )
        `)
      }
      // Code bodies are whole-token indexed: one entry per token instead
      // of one per trigram. `unicode61` is available in every SQLite
      // build that ships FTS5, so no probe is needed here. `detail='col'`
      // drops per-occurrence position lists (phrase/NEAR queries stop
      // working, but nothing issues those — every MATCH is quoted terms
      // joined by AND/OR and ranking is bm25-only, both of which are
      // position-independent and verified bit-identical against
      // detail=full). Positions are the bulk of a code index, so this
      // roughly halves it again on top of the tokenizer win.
      yield* tx.run(sql`
        CREATE VIRTUAL TABLE \`codegraph_fts_code\` USING fts5(
          \`code\`,
          content='codegraph_nodes',
          content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2',
          detail='col'
        )
      `)

      yield* tx.run(sql`
        CREATE TRIGGER \`codegraph_fts_insert\` AFTER INSERT ON \`codegraph_nodes\` BEGIN
          INSERT INTO \`codegraph_fts\`(\`rowid\`, \`name\`, \`signature\`)
          VALUES (new.\`rowid\`, new.\`name\`, COALESCE(new.\`signature\`, ''));
        END
      `)

      yield* tx.run(sql`
        CREATE TRIGGER \`codegraph_fts_delete\` AFTER DELETE ON \`codegraph_nodes\` BEGIN
          INSERT INTO \`codegraph_fts\`(\`codegraph_fts\`, \`rowid\`, \`name\`, \`signature\`)
          VALUES('delete', old.\`rowid\`, old.\`name\`, COALESCE(old.\`signature\`, ''));
        END
      `)

      yield* tx.run(sql`
        CREATE TRIGGER \`codegraph_fts_update\` AFTER UPDATE ON \`codegraph_nodes\` BEGIN
          INSERT INTO \`codegraph_fts\`(\`codegraph_fts\`, \`rowid\`, \`name\`, \`signature\`)
          VALUES('delete', old.\`rowid\`, old.\`name\`, COALESCE(old.\`signature\`, ''));
          INSERT INTO \`codegraph_fts\`(\`rowid\`, \`name\`, \`signature\`)
          VALUES (new.\`rowid\`, new.\`name\`, COALESCE(new.\`signature\`, ''));
        END
      `)

      yield* tx.run(sql`
        CREATE TRIGGER \`codegraph_fts_code_insert\` AFTER INSERT ON \`codegraph_nodes\` BEGIN
          INSERT INTO \`codegraph_fts_code\`(\`rowid\`, \`code\`)
          VALUES (new.\`rowid\`, COALESCE(new.\`code\`, ''));
        END
      `)

      yield* tx.run(sql`
        CREATE TRIGGER \`codegraph_fts_code_delete\` AFTER DELETE ON \`codegraph_nodes\` BEGIN
          INSERT INTO \`codegraph_fts_code\`(\`codegraph_fts_code\`, \`rowid\`, \`code\`)
          VALUES('delete', old.\`rowid\`, COALESCE(old.\`code\`, ''));
        END
      `)

      yield* tx.run(sql`
        CREATE TRIGGER \`codegraph_fts_code_update\` AFTER UPDATE ON \`codegraph_nodes\` BEGIN
          INSERT INTO \`codegraph_fts_code\`(\`codegraph_fts_code\`, \`rowid\`, \`code\`)
          VALUES('delete', old.\`rowid\`, COALESCE(old.\`code\`, ''));
          INSERT INTO \`codegraph_fts_code\`(\`rowid\`, \`code\`)
          VALUES (new.\`rowid\`, COALESCE(new.\`code\`, ''));
        END
      `)

      // Batched backfill: one INSERT..SELECT per rowid chunk per table so
      // a large `codegraph_nodes` table does not build either index in a
      // single statement (per the migration batching lessons).
      const maxRow = yield* tx.get<{ m: number | null }>(sql`SELECT MAX(\`rowid\`) AS m FROM \`codegraph_nodes\``)
      const max = maxRow?.m ?? 0
      const CHUNK = 2000
      for (let lo = 1; lo <= max; lo += CHUNK) {
        const hi = lo + CHUNK - 1
        yield* tx.run(sql`
          INSERT INTO \`codegraph_fts\`(\`rowid\`, \`name\`, \`signature\`)
          SELECT \`rowid\`, \`name\`, COALESCE(\`signature\`, '')
          FROM \`codegraph_nodes\`
          WHERE \`rowid\` >= ${lo} AND \`rowid\` <= ${hi}
        `)
        yield* tx.run(sql`
          INSERT INTO \`codegraph_fts_code\`(\`rowid\`, \`code\`)
          SELECT \`rowid\`, COALESCE(\`code\`, '')
          FROM \`codegraph_nodes\`
          WHERE \`rowid\` >= ${lo} AND \`rowid\` <= ${hi}
        `)
      }
    })
  },
} satisfies DatabaseMigration.Migration

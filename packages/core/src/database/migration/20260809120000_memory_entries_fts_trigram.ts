import { Cause, Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

// WS3: memory FTS quality — trigram tokenizer + weighted bm25 support.
//
// Mirrors 20260801120000_codegraph_fts_tokenize exactly. Replaces the
// `unicode61 remove_diacritics 2` FTS5 table created in
// 20260711130000_memory_entries_fts with one that uses the FTS5 `trigram`
// tokenizer (SQLite 3.34+ / libsql 0.10+). trigram indexes all 3-character
// substrings of every token, so partial-key queries like `key-4` hit
// `bench:key-4` without requiring a whole-token (or prefix) match —
// unicode61 requires whole-token matches and misses those.
//
// Trigram support is probed at migration time. If the runtime SQLite does
// not advertise it (older libsql binary, system sqlite < 3.34, or a
// strict FTS5 build that omits the trigram helper), the migration logs a
// warning to stderr and falls back to `unicode61 remove_diacritics 2` so
// cold-start never throws.
//
// Drops + recreates the three content-sync triggers so they reference the
// same `key, title, body, kind` column set (unchanged, but recreated for
// symmetry with the table). Backfills from `memory_entries` after
// recreation.
export default {
  id: "20260809120000_memory_entries_fts_trigram",
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
              `[memory_entries_fts_trigram] trigram tokenizer unavailable; ` +
                `falling back to unicode61 remove_diacritics 2. Cause: ${Cause.pretty(cause)}\n` +
                "Partial-key queries will be noisier until the runtime SQLite is upgraded.\n",
            )
            return false
          }),
        ),
      )

      yield* tx.run(sql`DROP TRIGGER IF EXISTS \`memory_entries_fts_insert\``)
      yield* tx.run(sql`DROP TRIGGER IF EXISTS \`memory_entries_fts_delete\``)
      yield* tx.run(sql`DROP TRIGGER IF EXISTS \`memory_entries_fts_update\``)
      yield* tx.run(sql`DROP TABLE IF EXISTS \`memory_entries_fts\``)

      if (trigramSupported) {
        yield* tx.run(sql`
          CREATE VIRTUAL TABLE \`memory_entries_fts\` USING fts5(
            \`key\`,
            \`title\`,
            \`body\`,
            \`kind\`,
            content='memory_entries',
            content_rowid='rowid',
            tokenize='trigram'
          )
        `)
      } else {
        yield* tx.run(sql`
          CREATE VIRTUAL TABLE \`memory_entries_fts\` USING fts5(
            \`key\`,
            \`title\`,
            \`body\`,
            \`kind\`,
            content='memory_entries',
            content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
          )
        `)
      }

      yield* tx.run(sql`
        CREATE TRIGGER \`memory_entries_fts_insert\` AFTER INSERT ON \`memory_entries\` BEGIN
          INSERT INTO \`memory_entries_fts\`(\`rowid\`, \`key\`, \`title\`, \`body\`, \`kind\`)
          VALUES (new.\`rowid\`, new.\`key\`, COALESCE(new.\`title\`, ''), COALESCE(new.\`body\`, ''), COALESCE(new.\`kind\`, ''));
        END
      `)

      yield* tx.run(sql`
        CREATE TRIGGER \`memory_entries_fts_delete\` AFTER DELETE ON \`memory_entries\` BEGIN
          INSERT INTO \`memory_entries_fts\`(\`memory_entries_fts\`, \`rowid\`, \`key\`, \`title\`, \`body\`, \`kind\`)
          VALUES('delete', old.\`rowid\`, old.\`key\`, COALESCE(old.\`title\`, ''), COALESCE(old.\`body\`, ''), COALESCE(old.\`kind\`, ''));
        END
      `)

      yield* tx.run(sql`
        CREATE TRIGGER \`memory_entries_fts_update\` AFTER UPDATE ON \`memory_entries\` BEGIN
          INSERT INTO \`memory_entries_fts\`(\`memory_entries_fts\`, \`rowid\`, \`key\`, \`title\`, \`body\`, \`kind\`)
          VALUES('delete', old.\`rowid\`, old.\`key\`, COALESCE(old.\`title\`, ''), COALESCE(old.\`body\`, ''), COALESCE(old.\`kind\`, ''));
          INSERT INTO \`memory_entries_fts\`(\`rowid\`, \`key\`, \`title\`, \`body\`, \`kind\`)
          VALUES (new.\`rowid\`, new.\`key\`, COALESCE(new.\`title\`, ''), COALESCE(new.\`body\`, ''), COALESCE(new.\`kind\`, ''));
        END
      `)

      yield* tx.run(sql`
        INSERT INTO \`memory_entries_fts\`(\`rowid\`, \`key\`, \`title\`, \`body\`, \`kind\`)
        SELECT \`rowid\`, \`key\`, COALESCE(\`title\`, ''), COALESCE(\`body\`, ''), COALESCE(\`kind\`, '')
        FROM \`memory_entries\`
      `)
    })
  },
} satisfies DatabaseMigration.Migration

import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Phase 1a: FTS5 virtual table for memory_entries, mirrors the codegraph_fts
// pattern. Content-sync via INSERT / UPDATE / DELETE triggers keeps the FTS
// index in lockstep with memory_entries. Backfill runs once for legacy rows.
//
// Columns indexed: key, title, body, kind. tags are stored as JSON in the
// envelope and indexed implicitly when they appear inside body.
export default {
  id: "20260711130000_memory_entries_fts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS \`memory_entries_fts\` USING fts5(
          \`key\`,
          \`title\`,
          \`body\`,
          \`kind\`,
          content='memory_entries',
          content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        )
      `)

      yield* tx.run(`DROP TRIGGER IF EXISTS \`memory_entries_fts_insert\``)
      yield* tx.run(`
        CREATE TRIGGER \`memory_entries_fts_insert\` AFTER INSERT ON \`memory_entries\` BEGIN
          INSERT INTO \`memory_entries_fts\`(\`rowid\`, \`key\`, \`title\`, \`body\`, \`kind\`)
          VALUES (new.\`rowid\`, new.\`key\`, COALESCE(new.\`title\`, ''), COALESCE(new.\`body\`, ''), COALESCE(new.\`kind\`, ''));
        END
      `)

      yield* tx.run(`DROP TRIGGER IF EXISTS \`memory_entries_fts_delete\``)
      yield* tx.run(`
        CREATE TRIGGER \`memory_entries_fts_delete\` AFTER DELETE ON \`memory_entries\` BEGIN
          INSERT INTO \`memory_entries_fts\`(\`memory_entries_fts\`, \`rowid\`, \`key\`, \`title\`, \`body\`, \`kind\`)
          VALUES('delete', old.\`rowid\`, old.\`key\`, COALESCE(old.\`title\`, ''), COALESCE(old.\`body\`, ''), COALESCE(old.\`kind\`, ''));
        END
      `)

      yield* tx.run(`DROP TRIGGER IF EXISTS \`memory_entries_fts_update\``)
      yield* tx.run(`
        CREATE TRIGGER \`memory_entries_fts_update\` AFTER UPDATE ON \`memory_entries\` BEGIN
          INSERT INTO \`memory_entries_fts\`(\`memory_entries_fts\`, \`rowid\`, \`key\`, \`title\`, \`body\`, \`kind\`)
          VALUES('delete', old.\`rowid\`, old.\`key\`, COALESCE(old.\`title\`, ''), COALESCE(old.\`body\`, ''), COALESCE(old.\`kind\`, ''));
          INSERT INTO \`memory_entries_fts\`(\`rowid\`, \`key\`, \`title\`, \`body\`, \`kind\`)
          VALUES (new.\`rowid\`, new.\`key\`, COALESCE(new.\`title\`, ''), COALESCE(new.\`body\`, ''), COALESCE(new.\`kind\`, ''));
        END
      `)

      // Backfill: rows that pre-date the FTS table get indexed once.
      yield* tx.run(`
        INSERT INTO \`memory_entries_fts\`(\`rowid\`, \`key\`, \`title\`, \`body\`, \`kind\`)
        SELECT \`rowid\`, \`key\`, COALESCE(\`title\`, ''), COALESCE(\`body\`, ''), COALESCE(\`kind\`, '')
        FROM \`memory_entries\`
      `)
    })
  },
} satisfies DatabaseMigration.Migration
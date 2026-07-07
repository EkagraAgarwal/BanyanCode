import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

export default {
  id: "20250707120000_codegraph_fts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS \`codegraph_fts\` USING fts5(
          name,
          code,
          content='codegraph_nodes',
          content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        )
      `)

      yield* tx.run(`DROP TRIGGER IF EXISTS \`codegraph_fts_insert\``)
      yield* tx.run(`
        CREATE TRIGGER \`codegraph_fts_insert\` AFTER INSERT ON \`codegraph_nodes\` BEGIN
          INSERT INTO \`codegraph_fts\`(\`rowid\`, \`name\`, \`code\`) VALUES (new.\`rowid\`, new.\`name\`, new.\`code\`);
        END
      `)

      yield* tx.run(`DROP TRIGGER IF EXISTS \`codegraph_fts_delete\``)
      yield* tx.run(`
        CREATE TRIGGER \`codegraph_fts_delete\` AFTER DELETE ON \`codegraph_nodes\` BEGIN
          INSERT INTO \`codegraph_fts\`(\`codegraph_fts\`, \`rowid\`, \`name\`, \`code\`) VALUES('delete', old.\`rowid\`, old.\`name\`, old.\`code\`);
        END
      `)

      yield* tx.run(`DROP TRIGGER IF EXISTS \`codegraph_fts_update\``)
      yield* tx.run(`
        CREATE TRIGGER \`codegraph_fts_update\` AFTER UPDATE ON \`codegraph_nodes\` BEGIN
          INSERT INTO \`codegraph_fts\`(\`codegraph_fts\`, \`rowid\`, \`name\`, \`code\`) VALUES('delete', old.\`rowid\`, old.\`name\`, old.\`code\`);
          INSERT INTO \`codegraph_fts\`(\`rowid\`, \`name\`, \`code\`) VALUES (new.\`rowid\`, new.\`name\`, new.\`code\`);
        END
      `)

      yield* tx.run(`
        INSERT INTO \`codegraph_fts\`(\`rowid\`, \`name\`, \`code\`)
          SELECT \`rowid\`, \`name\`, \`code\` FROM \`codegraph_nodes\` WHERE \`code\` IS NOT NULL
      `)
    })
  },
} satisfies DatabaseMigration.Migration
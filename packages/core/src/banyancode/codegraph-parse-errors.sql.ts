import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

export const CodegraphParseErrorsTable = sqliteTable("codegraph_parse_errors", {
  id: integer().primaryKey({ autoIncrement: true }),
  path: text().notNull(),
  cause: text().notNull(),
  indexed_at: integer().notNull(),
})
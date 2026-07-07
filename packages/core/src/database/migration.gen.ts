import type { DatabaseMigration } from "./migration"

export const migrations = (
  await Promise.all([
    import("./migration/20260621120000_libsql_fresh"),
    import("./migration/20260625120000_drop_codegraph_embeddings"),
    import("./migration/20250706120000_codegraph_parse_errors"),
    import("./migration/20260707120000_codegraph_fts"),
    import("./migration/20260708120000_codegraph_traces"),
  ])
).map((module) => module.default) satisfies DatabaseMigration.Migration[]

import type { DatabaseMigration } from "./migration"

export const migrations = (
  await Promise.all([
    import("./migration/20260621120000_libsql_fresh"),
    import("./migration/20260625120000_drop_codegraph_embeddings"),
  ])
).map((module) => module.default) satisfies DatabaseMigration.Migration[]

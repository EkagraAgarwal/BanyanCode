import type { DatabaseMigration } from "./migration"

export const migrations = (
  await Promise.all([
    import("./migration/20260621120000_libsql_fresh"),
    import("./migration/20260625120000_drop_codegraph_embeddings"),
    import("./migration/20250706120000_codegraph_parse_errors"),
    import("./migration/20260707120000_codegraph_fts"),
    import("./migration/20260708120000_codegraph_traces"),
    import("./migration/20260708130000_codegraph_service_tags"),
    import("./migration/20260708140000_codegraph_node_entrypoint_signals"),
    import("./migration/20260711120000_memory_payload_columns"),
    import("./migration/20260711130000_memory_entries_fts"),
    import("./migration/20260712000000_codegraph_indexed_root"),
  ])
).map((module) => module.default) satisfies DatabaseMigration.Migration[]

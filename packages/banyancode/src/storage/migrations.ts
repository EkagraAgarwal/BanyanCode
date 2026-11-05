/**
 * Fresh v2 schema for the BanyanCode plugin database.
 *
 * Ported from the v1 drizzle declarations (`packages/core/src/banyancode/*.sql.ts`
 * in v1) and the v1 migrations (`packages/core/src/database/migration/`).
 * Memory tables are deliberately absent (the memory feature is dropped in v2).
 *
 * The list is ordered and append-only: never edit a shipped migration, add a
 * new one. `applyMigrations` records each id in `banyancode_migrations`.
 */
export interface Migration {
  readonly id: string
  readonly statements: readonly string[]
}

export const migrations: readonly Migration[] = [
  {
    id: "20261031000100_codegraph",
    statements: [
      `CREATE TABLE IF NOT EXISTS codegraph_files (
        id text PRIMARY KEY NOT NULL,
        path text NOT NULL UNIQUE,
        content_hash text NOT NULL,
        language text NOT NULL,
        indexed_at integer NOT NULL,
        size_bytes integer NOT NULL DEFAULT 0,
        mtime_ms integer NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS codegraph_nodes (
        id text PRIMARY KEY NOT NULL,
        file_id text NOT NULL REFERENCES codegraph_files(id) ON DELETE CASCADE,
        kind text NOT NULL,
        name text NOT NULL,
        signature text,
        start_line integer NOT NULL,
        end_line integer NOT NULL,
        code text,
        is_entrypoint integer NOT NULL DEFAULT 0,
        in_degree integer NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS codegraph_node_file_name_idx ON codegraph_nodes (file_id, name)`,
      `CREATE INDEX IF NOT EXISTS codegraph_node_kind_name_idx ON codegraph_nodes (kind, name)`,
      `CREATE INDEX IF NOT EXISTS codegraph_node_name_idx ON codegraph_nodes (name)`,
      `CREATE INDEX IF NOT EXISTS codegraph_nodes_is_entrypoint_idx ON codegraph_nodes (is_entrypoint)`,
      `CREATE INDEX IF NOT EXISTS codegraph_nodes_in_degree_idx ON codegraph_nodes (in_degree)`,
      `CREATE TABLE IF NOT EXISTS codegraph_edges (
        id text PRIMARY KEY NOT NULL,
        from_node_id text NOT NULL REFERENCES codegraph_nodes(id) ON DELETE CASCADE,
        to_node_id text NOT NULL REFERENCES codegraph_nodes(id) ON DELETE CASCADE,
        kind text NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS codegraph_edge_from_idx ON codegraph_edges (from_node_id)`,
      `CREATE INDEX IF NOT EXISTS codegraph_edge_to_idx ON codegraph_edges (to_node_id)`,
      `CREATE TABLE IF NOT EXISTS codegraph_meta (
        id text PRIMARY KEY NOT NULL,
        graph_built_at integer NOT NULL,
        graph_version integer NOT NULL,
        graph_coverage real NOT NULL,
        total_files integer NOT NULL,
        total_nodes integer NOT NULL,
        total_edges integer NOT NULL,
        schema_version integer NOT NULL,
        indexed_root text
      )`,
      `CREATE TABLE IF NOT EXISTS codegraph_parse_errors (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        path text NOT NULL,
        cause text NOT NULL,
        indexed_at integer NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS codegraph_tool_usage (
        tool_id text PRIMARY KEY NOT NULL,
        session_id text,
        last_used_at integer NOT NULL DEFAULT 0,
        use_count integer NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS codegraph_service_tags (
        id text PRIMARY KEY NOT NULL,
        tag text NOT NULL,
        service_name text NOT NULL,
        file_id text NOT NULL,
        node_id text NOT NULL,
        class_name text NOT NULL,
        indexed_at integer NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS codegraph_service_tags_tag_idx ON codegraph_service_tags (tag)`,
      `CREATE INDEX IF NOT EXISTS codegraph_service_tags_service_name_idx ON codegraph_service_tags (service_name)`,
      `CREATE INDEX IF NOT EXISTS codegraph_service_tags_node_id_idx ON codegraph_service_tags (node_id)`,
      `CREATE TABLE IF NOT EXISTS codegraph_traces (
        id text PRIMARY KEY NOT NULL,
        trace_name text NOT NULL,
        from_node_id text,
        to_node_id text NOT NULL,
        observed_at integer NOT NULL,
        observed_at_bucket integer NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS codegraph_traces_trace_idx ON codegraph_traces (trace_name)`,
      `CREATE INDEX IF NOT EXISTS codegraph_traces_from_idx ON codegraph_traces (from_node_id)`,
      `CREATE INDEX IF NOT EXISTS codegraph_traces_to_idx ON codegraph_traces (to_node_id)`,
      `CREATE INDEX IF NOT EXISTS codegraph_traces_observed_at_idx ON codegraph_traces (observed_at)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS codegraph_traces_natural_key_idx ON codegraph_traces (trace_name, from_node_id, to_node_id, observed_at_bucket)`,
    ],
  },
  {
    id: "20261031000200_codegraph_nodes_fts",
    statements: [
      // Trigram tokenizer indexes every 3-character substring, so partial
      // identifiers (`anyan` -> `BanyanCode...`) match. Bun 1.4.4 and the
      // Node 24 node:sqlite build both ship FTS5 with trigram (spike result).
      `CREATE VIRTUAL TABLE IF NOT EXISTS codegraph_nodes_fts USING fts5(
        name,
        signature,
        code,
        content='codegraph_nodes',
        content_rowid='rowid',
        tokenize='trigram'
      )`,
      `CREATE TRIGGER IF NOT EXISTS codegraph_nodes_fts_insert AFTER INSERT ON codegraph_nodes BEGIN
        INSERT INTO codegraph_nodes_fts (rowid, name, signature, code)
        VALUES (new.rowid, new.name, COALESCE(new.signature, ''), COALESCE(new.code, ''));
      END`,
      `CREATE TRIGGER IF NOT EXISTS codegraph_nodes_fts_delete AFTER DELETE ON codegraph_nodes BEGIN
        INSERT INTO codegraph_nodes_fts (codegraph_nodes_fts, rowid, name, signature, code)
        VALUES ('delete', old.rowid, old.name, COALESCE(old.signature, ''), COALESCE(old.code, ''));
      END`,
      `CREATE TRIGGER IF NOT EXISTS codegraph_nodes_fts_update AFTER UPDATE ON codegraph_nodes BEGIN
        INSERT INTO codegraph_nodes_fts (codegraph_nodes_fts, rowid, name, signature, code)
        VALUES ('delete', old.rowid, old.name, COALESCE(old.signature, ''), COALESCE(old.code, ''));
        INSERT INTO codegraph_nodes_fts (rowid, name, signature, code)
        VALUES (new.rowid, new.name, COALESCE(new.signature, ''), COALESCE(new.code, ''));
      END`,
      `INSERT INTO codegraph_nodes_fts (rowid, name, signature, code)
        SELECT rowid, name, COALESCE(signature, ''), COALESCE(code, '') FROM codegraph_nodes`,
    ],
  },
  {
    id: "20261031000300_verification_runs",
    statements: [
      `CREATE TABLE IF NOT EXISTS verification_runs (
        id integer PRIMARY KEY AUTOINCREMENT,
        kind text NOT NULL,
        target text NOT NULL,
        status text NOT NULL,
        started_at integer NOT NULL DEFAULT (unixepoch()),
        completed_at integer,
        duration_ms integer,
        summary text,
        raw_output text,
        cache_key text
      )`,
      `CREATE INDEX IF NOT EXISTS verification_runs_kind_completed_idx ON verification_runs (kind, completed_at DESC)`,
      `CREATE INDEX IF NOT EXISTS verification_runs_cache_key_idx ON verification_runs (cache_key)`,
    ],
  },
  {
    id: "20261031000400_mesh",
    statements: [
      `CREATE TABLE IF NOT EXISTS subagent_messages (
        id text PRIMARY KEY NOT NULL,
        parent_session_id text NOT NULL,
        from_session text NOT NULL,
        from_agent text NOT NULL,
        to_session text,
        to_agent text,
        kind text NOT NULL,
        payload text NOT NULL,
        created_at integer NOT NULL,
        delivered_at integer
      )`,
      `CREATE INDEX IF NOT EXISTS subagent_msg_parent_delivered_idx ON subagent_messages (parent_session_id, delivered_at)`,
      `CREATE TABLE IF NOT EXISTS subagent_plans (
        id text PRIMARY KEY NOT NULL,
        parent_session_id text NOT NULL,
        agent text NOT NULL,
        session_id text NOT NULL,
        title text NOT NULL,
        steps text NOT NULL,
        exit_criteria text NOT NULL,
        status text NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS subagent_plan_parent_idx ON subagent_plans (parent_session_id)`,
      `CREATE INDEX IF NOT EXISTS subagent_plan_session_idx ON subagent_plans (session_id)`,
      `CREATE TABLE IF NOT EXISTS subagent_review_requests (
        id text PRIMARY KEY NOT NULL,
        parent_session_id text NOT NULL,
        target_agent text NOT NULL,
        diff text,
        description text,
        paths text,
        priority text,
        reason text,
        status text NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL,
        result text
      )`,
      `CREATE INDEX IF NOT EXISTS subagent_review_parent_idx ON subagent_review_requests (parent_session_id)`,
      `CREATE INDEX IF NOT EXISTS subagent_review_status_idx ON subagent_review_requests (status)`,
    ],
  },
  {
    // Tool usage kept one row per tool for the lifetime, with a single
    // `session_id` column: the first session that used a tool owned it. Split
    // attribution into its own table and keep `codegraph_tool_usage` as the
    // lifetime rollup. `gateway_usage` records what the repository gateway did
    // per session, so the sidebar can show swaps rather than only the tool that
    // happened to run.
    id: "20261105000100_tool_usage_attribution",
    statements: [
      `CREATE TABLE IF NOT EXISTS tool_usage_session (
        session_id text NOT NULL,
        tool_id text NOT NULL,
        last_used_at integer NOT NULL DEFAULT 0,
        use_count integer NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, tool_id)
      )`,
      `CREATE INDEX IF NOT EXISTS tool_usage_session_tool_idx ON tool_usage_session (tool_id)`,
      // The pre-migration row named only the first session that used a tool;
      // carry that attribution into the new table instead of dropping it.
      `INSERT OR IGNORE INTO tool_usage_session (session_id, tool_id, last_used_at, use_count)
        SELECT session_id, tool_id, last_used_at, use_count FROM codegraph_tool_usage
        WHERE session_id IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS gateway_usage (
        session_id text NOT NULL,
        from_tool text NOT NULL,
        to_tool text NOT NULL,
        route text NOT NULL,
        last_used_at integer NOT NULL DEFAULT 0,
        use_count integer NOT NULL DEFAULT 0,
        bytes_saved integer NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, from_tool, to_tool, route)
      )`,
      `CREATE INDEX IF NOT EXISTS gateway_usage_session_idx ON gateway_usage (session_id)`,
    ],
  },
]

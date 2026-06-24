import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Fresh libsql-native schema — all tables in one migration.
// FTS5 triggers and JSONB columns are native to libsql.
export default {
  id: "20260621120000_libsql_fresh",
  up(tx) {
    return Effect.gen(function* () {
      // ── account ──────────────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        )`)

      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text REFERENCES \`account\`(\`id\`) ON DELETE SET NULL,
          \`active_org_id\` text
        )`)

      // Legacy control_account
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL DEFAULT 0,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          PRIMARY KEY (\`email\`, \`url\`)
        )`)

      // ── data_migration ────────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        )`)

      // ── event ────────────────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text NOT NULL PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        )`)

      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL
        )`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`, \`seq\`)`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`, \`type\`, \`seq\`)`)

      // ── project ───────────────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        )`)

      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          \`directory\` text NOT NULL,
          \`type\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          PRIMARY KEY (\`project_id\`, \`directory\`)
        )`)

      // ── workspace ────────────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text NOT NULL DEFAULT '',
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          \`time_used\` integer NOT NULL
        )`)

      // ── permission ───────────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        )`)
      yield* tx.run(`CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`, \`action\`, \`resource\`)`)

      // ── session ─────────────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real NOT NULL DEFAULT 0,
          \`tokens_input\` integer NOT NULL DEFAULT 0,
          \`tokens_output\` integer NOT NULL DEFAULT 0,
          \`tokens_reasoning\` integer NOT NULL DEFAULT 0,
          \`tokens_cache_read\` integer NOT NULL DEFAULT 0,
          \`tokens_cache_write\` integer NOT NULL DEFAULT 0,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer
        )`)
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`)`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`)`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`)`)

      // ── message ─────────────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL
        )`)
      yield* tx.run(`CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`, \`time_created\`, \`id\`)`)

      // ── part ────────────────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`part\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL REFERENCES \`message\`(\`id\`) ON DELETE CASCADE,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL
        )`)
      yield* tx.run(`CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`, \`id\`)`)
      yield* tx.run(`CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`)`)

      // ── todo ────────────────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          PRIMARY KEY (\`session_id\`, \`position\`)
        )`)
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`)`)

      // ── session_message ──────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL
        )`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`, \`seq\`)`)
      yield* tx.run(`CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`, \`type\`, \`seq\`)`)
      yield* tx.run(`CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`, \`time_created\`, \`id\`)`)
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`)`)

      // ── session_input (inbox) ───────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL
        )`)
      yield* tx.run(`CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`, \`promoted_seq\`, \`delivery\`, \`admitted_seq\`)`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`, \`admitted_seq\`)`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`, \`promoted_seq\`)`)

      // ── session_context_epoch ───────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`session_context_epoch\` (
          \`session_id\` text NOT NULL PRIMARY KEY REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          \`baseline\` text NOT NULL,
          \`agent\` text NOT NULL DEFAULT 'agent.default',
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          \`replacement_seq\` integer,
          \`revision\` integer NOT NULL DEFAULT 0
        )`)

      // ── session_share ───────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`session_share\` (
          \`session_id\` text PRIMARY KEY REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          \`id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        )`)

      // ── memory_entries (with JSONB + versioning) ────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`memory_entries\` (
          \`id\` text PRIMARY KEY,
          \`key\` text NOT NULL,
          \`value\` jsonb NOT NULL,
          \`context\` text,
          \`tags\` jsonb NOT NULL DEFAULT '[]',
          \`scope\` text NOT NULL,
          \`session_id\` text,
          \`created_at\` integer NOT NULL,
          \`expires_at\` integer,
          \`agent_id\` text,
          \`version\` integer NOT NULL DEFAULT 1,
          \`updated_at\` integer NOT NULL,
          \`namespace\` text
        )`)
      yield* tx.run(`CREATE INDEX \`memory_scope_key_idx\` ON \`memory_entries\` (\`scope\`, \`key\`)`)
      yield* tx.run(`CREATE INDEX \`memory_scope_session_idx\` ON \`memory_entries\` (\`scope\`, \`session_id\`)`)

      // ── codegraph_meta ──────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`codegraph_meta\` (
          \`id\` text PRIMARY KEY,
          \`graph_built_at\` integer NOT NULL,
          \`graph_version\` integer NOT NULL,
          \`graph_coverage\` real NOT NULL,
          \`total_files\` integer NOT NULL,
          \`total_nodes\` integer NOT NULL,
          \`total_edges\` integer NOT NULL,
          \`schema_version\` integer NOT NULL
        )`)

      // ── codegraph_files ─────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`codegraph_files\` (
          \`id\` text PRIMARY KEY,
          \`path\` text NOT NULL UNIQUE,
          \`content_hash\` text NOT NULL,
          \`language\` text NOT NULL,
          \`indexed_at\` integer NOT NULL
        )`)

      // ── codegraph_nodes ─────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`codegraph_nodes\` (
          \`id\` text PRIMARY KEY,
          \`file_id\` text NOT NULL REFERENCES \`codegraph_files\`(\`id\`) ON DELETE CASCADE,
          \`kind\` text NOT NULL,
          \`name\` text NOT NULL,
          \`signature\` text,
          \`start_line\` integer NOT NULL,
          \`end_line\` integer NOT NULL,
          \`code\` text
        )`)
      yield* tx.run(`CREATE INDEX \`codegraph_node_file_name_idx\` ON \`codegraph_nodes\` (\`file_id\`, \`name\`)`)
      yield* tx.run(`CREATE INDEX \`codegraph_node_kind_name_idx\` ON \`codegraph_nodes\` (\`kind\`, \`name\`)`)

      // ── FTS5 virtual table + triggers for codegraph_nodes ───────────────────
      yield* tx.run(`
        CREATE VIRTUAL TABLE codegraph_nodes_fts USING fts5(
          node_id UNINDEXED,
          name,
          kind,
          content='codegraph_nodes',
          content_rowid='rowid'
        )`)
      yield* tx.run(`
        CREATE TRIGGER codegraph_nodes_ai AFTER INSERT ON codegraph_nodes BEGIN
          INSERT INTO codegraph_nodes_fts(rowid, node_id, name, kind)
          VALUES (new.rowid, new.id, new.name, new.kind);
        END`)
      yield* tx.run(`
        CREATE TRIGGER codegraph_nodes_ad AFTER DELETE ON codegraph_nodes BEGIN
          INSERT INTO codegraph_nodes_fts(codegraph_nodes_fts, rowid, node_id, name, kind)
          VALUES('delete', old.rowid, old.id, old.name, old.kind);
        END`)
      yield* tx.run(`
        CREATE TRIGGER codegraph_nodes_au AFTER UPDATE ON codegraph_nodes BEGIN
          INSERT INTO codegraph_nodes_fts(codegraph_nodes_fts, rowid, node_id, name, kind)
          VALUES('delete', old.rowid, old.id, old.name, old.kind);
          INSERT INTO codegraph_nodes_fts(rowid, node_id, name, kind)
          VALUES (new.rowid, new.id, new.name, new.kind);
        END`)

      // ── codegraph_edges ────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`codegraph_edges\` (
          \`id\` text PRIMARY KEY,
          \`from_node_id\` text NOT NULL REFERENCES \`codegraph_nodes\`(\`id\`) ON DELETE CASCADE,
          \`to_node_id\` text NOT NULL REFERENCES \`codegraph_nodes\`(\`id\`) ON DELETE CASCADE,
          \`kind\` text NOT NULL
        )`)
      yield* tx.run(`CREATE INDEX \`codegraph_edge_from_idx\` ON \`codegraph_edges\` (\`from_node_id\`)`)
      yield* tx.run(`CREATE INDEX \`codegraph_edge_to_idx\` ON \`codegraph_edges\` (\`to_node_id\`)`)

      // ── subagent_plans ──────────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`subagent_plans\` (
          \`id\` text PRIMARY KEY,
          \`parent_session_id\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`steps\` text NOT NULL,
          \`exit_criteria\` text NOT NULL,
          \`status\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL
        )`)
      yield* tx.run(`CREATE INDEX \`subagent_plan_parent_idx\` ON \`subagent_plans\` (\`parent_session_id\`)`)
      yield* tx.run(`CREATE INDEX \`subagent_plan_session_idx\` ON \`subagent_plans\` (\`session_id\`)`)

      // ── subagent_messages ───────────────────────────────────────────────────
      yield* tx.run(`
        CREATE TABLE \`subagent_messages\` (
          \`id\` text PRIMARY KEY,
          \`parent_session_id\` text NOT NULL,
          \`from_session\` text NOT NULL,
          \`from_agent\` text NOT NULL,
          \`to_session\` text,
          \`to_agent\` text,
          \`kind\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`delivered_at\` integer
        )`)
      yield* tx.run(`CREATE INDEX \`subagent_msg_parent_delivered_idx\` ON \`subagent_messages\` (\`parent_session_id\`, \`delivered_at\`)`)
    })
  },
} satisfies DatabaseMigration.Migration

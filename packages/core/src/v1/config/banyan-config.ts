export * as BanyanConfig from "./banyan-config"

import { Schema } from "effect"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"

export const Schema_URL = "https://banyan.dev/schema/banyancode.json"

export const OpenAICompatibleEndpoint = Schema.Struct({
  name: Schema.String,
  base_url: Schema.String,
  api_key: Schema.optional(Schema.String),
  models: Schema.optional(Schema.Array(Schema.String)),
})

export const DEFAULT_MAX_SUBAGENTS = 5
export const MAX_SUBAGENTS_LIMIT = 20

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  banyancode_openai_compatible_endpoints: Schema.optional(Schema.Array(OpenAICompatibleEndpoint)),
  banyancode_yolo_mode: Schema.optional(Schema.Boolean),
  banyancode_disable_websearch: Schema.optional(Schema.Boolean),
  banyancode_telegram_enabled: Schema.optional(Schema.Boolean),
  banyancode_telegram_bot_token: Schema.optional(Schema.String),
  banyancode_telegram_webhook_secret: Schema.optional(Schema.String),
  banyancode_telegram_default_session: Schema.optional(Schema.String),
  // Max number of subagents the orchestrator can run concurrently.
  // Used as both a prompt hint AND a hard runtime limit in MeshCoordinator.
  // Default: 5, max: 20
  banyancode_max_subagents: Schema.optional(Schema.Number),
  banyancode_git_author_email: Schema.optional(Schema.String),
  banyancode_codegraph_exclude_patterns: Schema.optional(Schema.Array(Schema.String)),
  banyancode_codegraph_concurrency: Schema.optional(Schema.Number),
  banyancode_codegraph_batch_size: Schema.optional(Schema.Number),
  // Incremental codegraph auto-update. When false, the file-watcher bridge
  // never invokes indexFiles/removeFiles in response to file events. The
  // user must run /codegraph-build manually. Debounce bounds the queue wake
  // signal so a `git rebase`-style burst collapses into one batch.
  banyancode_codegraph_watch_enabled: Schema.optional(Schema.Boolean),
  banyancode_codegraph_watch_debounce_ms: Schema.optional(Schema.Number),
  banyancode_trace_max_days: Schema.optional(Schema.Number),
  banyancode_trace_max_events: Schema.optional(Schema.Number),
  banyancode_mesh_default_provider: Schema.optional(Schema.String),
  banyancode_mesh_default_model: Schema.optional(Schema.String),
  banyancode_mesh_subagent_cooldown: Schema.optional(Schema.Number),
  // List of custom subagent definitions stored as markdown files in
  // .banyancode/agent/<name>.md. This field is metadata only —
  // actual agent configs are file-based (managed via dialog-agent-config).
  // The field stores the parsed frontmatter for quick enumeration without
  // re-reading files on every access.
  banyancode_subagents: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.optional(Schema.String),
        model: Schema.optional(
          Schema.Struct({
            providerID: Schema.String,
            modelID: Schema.String,
          }),
        ),
        tools: Schema.optional(Schema.Array(Schema.String)),
        mode: Schema.Literals(["subagent", "primary"]),
        enabled: Schema.optional(Schema.Boolean),
        filePath: Schema.String, // absolute path to the .md file
      }),
    ),
  ),
  // Per-agent model override map. Key is the agent name (e.g., "coder",
  // "researcher", "scout", "explore", "orchestrator"). Used by the task tool
  // to override the agent's static `model` config when spawning subagents.
  banyancode_agent_models: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        providerID: ProviderV2.ID,
        modelID: ModelV2.ID,
      }),
    ),
  ),
}).annotate({ identifier: "BanyanConfig" })

export type Info = typeof Info.Type

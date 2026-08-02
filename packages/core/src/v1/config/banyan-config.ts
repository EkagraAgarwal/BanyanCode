export * as BanyanConfig from "./banyan-config"

import { Schema } from "effect"
import { ConfigLSPV1 } from "./lsp"
import { EventV2 } from "../../event"

export const Event = {
  Updated: EventV2.define({
    type: "banyancode.config.updated",
    schema: {
      scope: Schema.optional(Schema.String),
    },
  }),
}

export const Schema_URL = "https://banyan.dev/schema/banyancode.json"

export const OpenAICompatibleEndpoint = Schema.Struct({
  name: Schema.String,
  base_url: Schema.String,
  api_key: Schema.optional(Schema.String),
  models: Schema.optional(Schema.Array(Schema.String)),
})

export const DEFAULT_MAX_SUBAGENTS = 5
export const MAX_SUBAGENTS_LIMIT = 20

// BanyanCode-owned LSP config. Mirrors the opencode `lsp` shape (boolean for
// built-in enable, record for per-server overrides) so users can disable,
// enable-all, or customize any built-in LSP from `banyancode.json` without
// touching opencode's config. BanyanCode is its own product identity and does
// not read `opencode.json`; LSP settings belong here.
export const LSP = ConfigLSPV1.Info

// Phase 6 (Verifier): per-project shell-command overrides for the verifier
// tools. All four slots default to a `bun run <name>` invocation that matches
// the project's package.json scripts; the override is only consulted when the
// user explicitly sets it. Commands run with the resolved projectRoot as cwd
// — path traversal is checked at the tool boundary (see verifier-service.ts).
export const Commands = Schema.Struct({
  typecheck: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  test: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  lint: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  compile: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
}).annotate({ identifier: "BanyanCommands" })

export type Commands = typeof Commands.Type

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  banyancode_openai_compatible_endpoints: Schema.optional(Schema.Array(OpenAICompatibleEndpoint)),
  banyancode_yolo_mode: Schema.optional(Schema.Boolean),
  // Default true. When false, `task({ background: true })` is rejected at the
  // tool boundary and the session-background HTTP route is a no-op. Override
  // here to disable for a single install; OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
  // (env) is the runtime override used by tests and OpenCode-only environments.
  banyancode_background_subagents: Schema.optional(Schema.Boolean),
  banyancode_disable_websearch: Schema.optional(Schema.Boolean),
  banyancode_telegram_enabled: Schema.optional(Schema.Boolean),
  banyancode_telegram_bot_token: Schema.optional(Schema.String),
  banyancode_telegram_webhook_secret: Schema.optional(Schema.String),
  banyancode_telegram_default_session: Schema.optional(Schema.String),
  // Max number of subagents the orchestrator can run concurrently.
  // Used as both a prompt hint AND a hard runtime limit in MeshCoordinator.
  // Default: 5, max: 20
  banyancode_max_subagents: Schema.optional(Schema.Number),
  /** Default evaluator model for /goal: a cheap/fast small model the reviewer is graded against. Format: "provider/model-id" e.g. "anthropic/claude-haiku-4-5". */
  banyancode_goal_evaluator_model: Schema.optional(Schema.String),
  /** Maximum number of reviewer-fail iterations before the goal is auto-blocked and surfaced to the user. Default 5. */
  banyancode_max_goal_iterations: Schema.optional(Schema.Number),
  /** Wall-clock budget for a single /goal run, in milliseconds. Default 45 minutes (2_700_000). 0 = no cap. */
  banyancode_goal_max_time_ms: Schema.optional(Schema.Number),
  /** Auto-retry the goal loop on reviewer `blocked` verdicts? Default true. If false, the first `blocked` verdict surfaces to the user. */
  banyancode_goal_auto_retry_on_block: Schema.optional(Schema.Boolean),
  banyancode_git_author_email: Schema.optional(Schema.String),
  banyancode_codegraph_exclude_patterns: Schema.optional(Schema.Array(Schema.String)),
  banyancode_codegraph_concurrency: Schema.optional(Schema.Number),
  banyancode_codegraph_batch_size: Schema.optional(Schema.Number),
  // Index backend for the codegraph parser. "js" = current regex/tree-sitter
  // pipeline (default). "rust" = opt-in to `native/codegraph-rs` via
  // BANYANCODE_CODEGRAPH_BIN or the bundled binary. Fail-open: if the rust
  // binary can't be resolved, the indexer falls back to "js" with a warning.
  banyancode_codegraph_backend: Schema.optional(Schema.Literals(["js", "rust"])),
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
  // BanyanCode-owned LSP config. True = enable all built-in LSP servers; a
  // record = enable built-ins with per-server overrides (disabled / custom
  // command / env / extensions / initialization). BanyanCode does not read
  // opencode's `lsp` field; users configure LSPs in `banyancode.json`.
  banyancode_lsp: Schema.optional(LSP).annotate({
    description:
      "Enable or configure BanyanCode's LSP servers. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  // Phase 6 (Verifier): per-project overrides for the typecheck/test/lint/
  // compile shell commands the verifier tools invoke. When unset, each tool
  // falls back to its default command (e.g. `bunx tsc --noEmit`). Commands
  // are validated to be shell command strings; path traversal is checked at
  // the tool boundary.
  commands: Schema.optional(Commands).annotate({
    description:
      "Override the shell command each verifier tool runs. Each entry replaces the default (`bunx tsc --noEmit`, `bun test`, `bun run lint`, `bun build`); omit to keep the default.",
  }),
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
  // Config for each agent (built-in or custom)
  agent: Schema.optional(
    Schema.Record(
      Schema.String.check(
        Schema.isPattern(/^[a-zA-Z0-9._-]+$/, {
          identifier: "AgentName",
          description: "Agent name (letters, digits, '.', '_', '-' only)",
        }),
        Schema.isMinLength(1),
        Schema.isMaxLength(64),
      ),
      Schema.Struct({
        mode: Schema.optional(Schema.Literals(["primary", "subagent"])),
        model: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
        permission: Schema.optional(Schema.Record(Schema.String, Schema.String)),
        options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(50_000))),
        enabled: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
}).annotate({ identifier: "BanyanConfig" })

export type Info = typeof Info.Type
export type AgentConfig = typeof Info.Type extends { agent?: infer A }
  ? A extends undefined
    ? never
    : NonNullable<A> extends Record<string, infer T>
      ? T
      : never
  : never


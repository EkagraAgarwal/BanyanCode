import { Schema } from "effect"

export const SchemaURL = "https://banyan.dev/schema/banyancode.json"

export const OpenAICompatibleEndpoint = Schema.Struct({
  name: Schema.String,
  base_url: Schema.String,
  api_key: Schema.optional(Schema.String),
  models: Schema.optional(Schema.Array(Schema.String)),
})

export const DEFAULT_MAX_SUBAGENTS = 5
export const MAX_SUBAGENTS_LIMIT = 20
export const DEFAULT_MAX_GOAL_ITERATIONS = 5

export const THINKING_LEVELS = ["off", "low", "medium", "high", "max", "xhigh", "ultra"] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium"
const ThinkingLevelSchema = Schema.Union([Schema.Literals([...THINKING_LEVELS]), Schema.String])

// BanyanCode-owned LSP config. Mirrors v1's ConfigLSPV1.Info: boolean to
// enable/disable the built-ins, or a record of per-server overrides.
export const LSP = Schema.Union([Schema.Boolean, Schema.Record(Schema.String, Schema.Union([
  Schema.Struct({ disabled: Schema.Literal(true) }),
  Schema.Struct({
    command: Schema.optional(Schema.Array(Schema.String)),
    extensions: Schema.optional(Schema.Array(Schema.String)),
    disabled: Schema.optional(Schema.Boolean),
    env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    initialization: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    maxMemoryMb: Schema.optional(Schema.Number),
    idleTimeoutMs: Schema.optional(Schema.Number),
  }),
]))])

export const Commands = Schema.Struct({
  typecheck: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  test: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  lint: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  compile: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
}).annotate({ identifier: "BanyanCommands" })

export type Commands = typeof Commands.Type

export const McpServerPermission = Schema.Literals(["reject", "edits"])
export type McpServerPermission = typeof McpServerPermission.Type

export const McpServer = Schema.Struct({
  default_agent: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
  default_model: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  permission: Schema.optional(McpServerPermission),
  max_concurrent_tasks: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 }))),
  task_budget_usd: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))),
  result_max_tokens: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 32000 }))),
  needs_input_timeout_seconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 86400 }))),
  output_max_chars: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 500_000 }))),
  allowed_agents: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
  ),
  allowed_models: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  ),
  tools: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]+$/), Schema.isMinLength(1), Schema.isMaxLength(64))),
  ),
})

export type McpServer = typeof McpServer.Type

const AgentName = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9._-]+$/),
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
)

const agentFields = {
  mode: Schema.optional(Schema.Literals(["primary", "subagent"])),
  model: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  // Thinking level for this agent (off/low/medium/high/max/xhigh/ultra or an
  // explicit variant id). An explicit `variant` wins over this.
  thinking: Schema.optional(ThinkingLevelSchema),
  // Escape hatch: explicit variant id, wins over `thinking`.
  variant: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  permission: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(50_000))),
  enabled: Schema.optional(Schema.Boolean),
} satisfies Schema.Struct.Fields

export const AgentConfig = Schema.Struct(agentFields)
export type AgentConfig = typeof AgentConfig.Type
export const AgentKeys: ReadonlySet<string> = new Set(Object.keys(agentFields))

const SubagentDefinition = Schema.Struct({
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
  filePath: Schema.String,
})

const infoFields = {
  $schema: Schema.optional(Schema.String),
  banyancode_openai_compatible_endpoints: Schema.optional(Schema.Array(OpenAICompatibleEndpoint)),
  banyancode_yolo_mode: Schema.optional(Schema.Boolean),
  banyancode_background_subagents: Schema.optional(Schema.Boolean),
  banyancode_disable_websearch: Schema.optional(Schema.Boolean),
  banyancode_telemetry: Schema.optional(Schema.Literals(["on", "off"])),
  banyancode_agent_telemetry: Schema.optional(Schema.Literals(["on", "off"])),
  banyancode_agent_telemetry_retention_days: Schema.optional(Schema.Number),
  banyancode_agent_telemetry_max_events: Schema.optional(Schema.Number),
  banyancode_telegram_enabled: Schema.optional(Schema.Boolean),
  banyancode_telegram_bot_token: Schema.optional(Schema.String),
  banyancode_telegram_webhook_secret: Schema.optional(Schema.String),
  banyancode_telegram_default_session: Schema.optional(Schema.String),
  banyancode_max_subagents: Schema.optional(Schema.Number),
  banyancode_router: Schema.optional(Schema.Literals(["off", "rules"])),
  banyancode_route_grep: Schema.optional(Schema.Boolean),
  banyancode_route_read: Schema.optional(Schema.Boolean),
  banyancode_route_glob: Schema.optional(Schema.Boolean),
  banyancode_router_trace: Schema.optional(Schema.Boolean),
  banyancode_augment_read: Schema.optional(Schema.Boolean),
  banyancode_read_outline_lines: Schema.optional(Schema.Number).annotate({
    description:
      "A whole-file read of an indexed code file longer than this many lines returns the file outline instead. Defaults to 400. Repeat the read for the raw text.",
  }),
  banyancode_goal_evaluator_model: Schema.optional(Schema.String),
  banyancode_max_goal_iterations: Schema.optional(Schema.Number),
  banyancode_goal_max_time_ms: Schema.optional(Schema.Number),
  banyancode_goal_auto_retry_on_block: Schema.optional(Schema.Boolean),
  banyancode_git_author_email: Schema.optional(Schema.String),
  banyancode_codegraph_exclude_patterns: Schema.optional(Schema.Array(Schema.String)),
  banyancode_codegraph_concurrency: Schema.optional(Schema.Number),
  banyancode_codegraph_batch_size: Schema.optional(Schema.Number),
  banyancode_codegraph_watch_enabled: Schema.optional(Schema.Boolean),
  banyancode_codegraph_watch_debounce_ms: Schema.optional(Schema.Number),
  banyancode_trace_max_days: Schema.optional(Schema.Number),
  banyancode_trace_max_events: Schema.optional(Schema.Number),
  banyancode_mesh_default_provider: Schema.optional(Schema.String),
  banyancode_mesh_default_model: Schema.optional(Schema.String),
  banyancode_mesh_subagent_cooldown: Schema.optional(Schema.Number),
  banyancode_thinking_default: Schema.optional(ThinkingLevelSchema),
  banyancode_swarm_mode: Schema.optional(Schema.Boolean),
  banyancode_prompt_cache_key: Schema.optional(
    Schema.Union([Schema.Literal("auto"), Schema.Literal("off"), Schema.NonEmptyString]),
  ),
  banyancode_prompt_cache_mode: Schema.optional(Schema.Literals(["implicit", "explicit", "off"])),
  banyancode_prompt_cache_diagnostics: Schema.optional(Schema.Boolean),
  banyancode_prompt_cache_stable_prefix: Schema.optional(Schema.Boolean),
  banyancode_prompt_cache_prewarm: Schema.optional(Schema.Boolean),
  banyancode_reasoning_configuration_update: Schema.optional(Schema.Boolean),
  banyancode_tool_search_defer: Schema.optional(Schema.Boolean),
  banyancode_lsp: Schema.optional(LSP).annotate({
    description:
      "Enable or configure BanyanCode's LSP servers. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  banyancode_lsp_idle_timeout_ms: Schema.optional(Schema.Number).annotate({
    description:
      "Idle timeout in ms after which an unused LSP client is shut down. Restart is transparent on next use. 0 disables idle shutdown.",
  }),
  commands: Schema.optional(Commands).annotate({
    description:
      "Override the shell command each verifier tool runs. Each entry replaces the default (`bunx tsc --noEmit`, `bun test`, `bun run lint`, `bun build`); omit to keep the default.",
  }),
  banyancode_subagents: Schema.optional(Schema.Array(SubagentDefinition)),
  agent: Schema.optional(Schema.Record(AgentName, AgentConfig)),
  banyancode_mcp_server: Schema.optional(McpServer).annotate({
    description:
      "Defaults for `banyancode mcp serve` task delegation (default agent/model, permission policy, concurrency and token caps, tool group allowlist).",
  }),
} satisfies Schema.Struct.Fields

export const Info = Schema.Struct(infoFields).annotate({ identifier: "BanyanConfig" })
export type Info = typeof Info.Type

export const InfoKeys: ReadonlySet<string> = new Set(Object.keys(infoFields))

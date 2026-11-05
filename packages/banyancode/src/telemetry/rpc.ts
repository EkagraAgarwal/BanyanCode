import { Rpc } from "@opencode/schema/rpc"
import { Schema } from "effect"
import { AgentEfficiencyEvent, AgentReport } from "./agent-telemetry.js"
import { ProviderUsageList } from "./provider-usage.js"
import { TokenUsageEvent } from "./tokens.js"

const ToolUsageRow = Schema.Struct({
  toolId: Schema.String,
  useCount: Schema.Number,
  lastUsedAt: Schema.Number,
}).annotate({ identifier: "Banyan.ToolUsageRow" })

const ToolUsageResult = Schema.Struct({
  tools: Schema.Array(ToolUsageRow),
}).annotate({ identifier: "Banyan.ToolUsageResult" })

const GatewayUsageRow = Schema.Struct({
  fromTool: Schema.String,
  toTool: Schema.String,
  route: Schema.Literals(["swapped", "fallback", "augmented", "direct"]),
  useCount: Schema.Number,
  bytesSaved: Schema.Number,
  lastUsedAt: Schema.Number,
}).annotate({ identifier: "Banyan.GatewayUsageRow" })

const GatewayUsageResult = Schema.Struct({
  rows: Schema.Array(GatewayUsageRow),
  summary: Schema.Struct({
    swapped: Schema.Number,
    fallback: Schema.Number,
    augmented: Schema.Number,
    direct: Schema.Number,
    bytesSaved: Schema.Number,
  }),
}).annotate({ identifier: "Banyan.GatewayUsageResult" })

const TokenUsageResult = Schema.Struct({
  events: Schema.Array(TokenUsageEvent),
}).annotate({ identifier: "Banyan.TokenUsageResult" })

const ProviderRefreshInput = Schema.Struct({
  providerID: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]+$/), Schema.isMaxLength(128)),
  ),
}).annotate({ identifier: "Banyan.ProviderUsageRefreshInput" })

const AgentFilterInput = Schema.Struct({
  runID: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  since: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
}).annotate({ identifier: "Banyan.AgentTelemetryFilter" })

const AgentExportResult = Schema.Struct({
  jsonl: Schema.String,
  count: Schema.Number,
  events: Schema.Array(AgentEfficiencyEvent),
}).annotate({ identifier: "Banyan.AgentTelemetryExport" })

/**
 * Plugin-owned usage surface. Mirrors v1's `GET /global/tool-usage`,
 * `GET /global/provider-usage`, `POST /global/provider-usage/refresh` and the
 * `banyancode telemetry agent-report|agent-export` commands.
 *
 * `providers` / `providersRefresh` are the names the TUI provider panel
 * already calls; `providerList` / `providerRefresh` are aliases matching the
 * v1 route names in the parity table.
 */
export const Definition = Rpc.define({
  id: "banyancode.usage",
  methods: {
    toolUsage: {
      input: Schema.Struct({ session: Schema.optional(Schema.String) }),
      output: ToolUsageResult,
    },
    gatewayUsage: {
      input: Schema.Struct({ session: Schema.optional(Schema.String) }),
      output: GatewayUsageResult,
    },
    tokenUsage: {
      input: Schema.Struct({
        session: Schema.optional(Schema.String),
        since: Schema.optional(Schema.Number),
      }),
      output: TokenUsageResult,
    },
    providers: {
      input: Schema.Struct({}),
      output: ProviderUsageList,
    },
    providersRefresh: {
      input: ProviderRefreshInput,
      output: ProviderUsageList,
    },
    providerList: {
      input: Schema.Struct({}),
      output: ProviderUsageList,
    },
    providerRefresh: {
      input: ProviderRefreshInput,
      output: ProviderUsageList,
    },
    "telemetry.agentReport": {
      input: AgentFilterInput,
      output: AgentReport,
    },
    "telemetry.agentExport": {
      input: AgentFilterInput,
      output: AgentExportResult,
    },
    "telemetry.agentPrune": {
      input: Schema.Struct({
        retentionMs: Schema.optional(Schema.Number),
        maxEvents: Schema.optional(Schema.Number),
      }),
      output: Schema.Struct({ ok: Schema.Boolean }),
    },
  },
  events: {},
})

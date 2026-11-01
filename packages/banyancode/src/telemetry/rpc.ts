export * as UsageRpc from "./rpc.js"

import { Rpc } from "@opencode/schema/rpc"
import { Schema } from "effect"
import { TokenUsageEvent } from "./tokens.js"

const ToolUsageRow = Schema.Struct({
  toolId: Schema.String,
  useCount: Schema.Number,
  lastUsedAt: Schema.Number,
}).annotate({ identifier: "Banyan.ToolUsageRow" })

const ToolUsageResult = Schema.Struct({
  tools: Schema.Array(ToolUsageRow),
}).annotate({ identifier: "Banyan.ToolUsageResult" })

const TokenUsageResult = Schema.Struct({
  events: Schema.Array(TokenUsageEvent),
}).annotate({ identifier: "Banyan.TokenUsageResult" })

/**
 * Plugin-owned usage surface. Mirrors v1's `GET /global/tool-usage` payload
 * (`toolUsage`) and exposes the token-attribution ring (`tokenUsage`).
 * Provider quota snapshots stay in workstream 3g.
 */
export const Definition = Rpc.define({
  id: "banyancode.usage",
  methods: {
    toolUsage: {
      input: Schema.Struct({ session: Schema.optional(Schema.String) }),
      output: ToolUsageResult,
    },
    tokenUsage: {
      input: Schema.Struct({
        session: Schema.optional(Schema.String),
        since: Schema.optional(Schema.Number),
      }),
      output: TokenUsageResult,
    },
  },
  events: {},
})

import { Context, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import type { ToolDefinition } from "@opencode-ai/llm"
import { Database } from "../database/database"
import type { AgentV2 } from "../agent"
import type { ModelV2 } from "../model"
import type { PermissionV2 } from "../permission"
import type { Interface as ToolRegistryInterface } from "../tool/registry"
import { Tool } from "../tool/tool"
import type { GraphPolicyEvent } from "./types"

export type Tier = "hot" | "warm" | "cold"

export interface AdaptedTool {
  readonly id: string
  readonly description: string
  readonly tier: Tier
  readonly schema: unknown
  readonly examples?: ReadonlyArray<string>
}

export interface MaterializeInput {
  readonly registry: ToolRegistryInterface
  readonly agent: AgentV2.Info
  readonly model: ModelV2.Info
}

export interface PolicyEventRow extends GraphPolicyEvent {
  readonly id: number
}

export interface Interface {
  readonly materialize: (input: MaterializeInput) => Effect.Effect<ReadonlyArray<AdaptedTool>, never, never>
  readonly tier: (tool: AdaptedTool) => Tier
  /**
   * Record one tool use against the composite `(session_id, tool_id)`
   * aggregate. Unlike the old tool_id-only upsert, a tool used by multiple
   * sessions keeps one row per session — the last session never overwrites
   * another session's count. Callers without a session use the `''` sentinel.
   */
  readonly recordUsage: (toolID: string, sessionID?: string) => Effect.Effect<void, never, never>
  /**
   * Append one per-turn graph-policy telemetry event (call, redirect, or
   * graph attempt) to `codegraph_policy_events`. The wrapper records ALL
   * tool calls through it so adoption metrics have an accurate denominator.
   */
  readonly recordPolicyEvent: (event: GraphPolicyEvent) => Effect.Effect<void, never, never>
  /** Read recorded policy events, newest first, optionally scoped to a session. */
  readonly listPolicyEvents: (input?: { sessionID?: string; limit?: number }) => Effect.Effect<PolicyEventRow[], never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/AdaptedCatalog") {}

const explicitlyAllowed = (toolID: string, permissions: PermissionV2.Ruleset) =>
  permissions.some((rule) => rule.action === toolID && rule.resource === "*" && rule.effect === "allow")

const toAdapted = (definition: ToolDefinition, tier: Tier): AdaptedTool => ({
  id: definition.name,
  description: definition.description,
  tier,
  schema: definition.inputSchema,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const recordUsage = Effect.fn("AdaptedCatalog.recordUsage")(function* (toolID: string, sessionID?: string) {
      yield* db.run(sql`
        INSERT INTO codegraph_tool_usage (session_id, tool_id, last_used_at, use_count)
        VALUES (${sessionID ?? ""}, ${toolID}, unixepoch(), 1)
        ON CONFLICT(session_id, tool_id) DO UPDATE SET
          last_used_at = unixepoch(),
          use_count = codegraph_tool_usage.use_count + 1
      `).pipe(Effect.orDie)
    })

    const recordPolicyEvent = Effect.fn("AdaptedCatalog.recordPolicyEvent")(function* (event: GraphPolicyEvent) {
      yield* db.run(sql`
        INSERT INTO codegraph_policy_events (session_id, message_id, tool_id, event_type, mode, ts, graph_state, outcome)
        VALUES (${event.sessionID}, ${event.messageID}, ${event.toolID}, ${event.eventType}, ${event.mode}, ${event.ts}, ${event.graphState ?? null}, ${event.outcome ?? null})
      `).pipe(Effect.orDie)
    })

    const listPolicyEvents = Effect.fn("AdaptedCatalog.listPolicyEvents")(function* (input?: {
      sessionID?: string
      limit?: number
    }) {
      const rows = yield* db
        .all<{
          id: number
          session_id: string
          message_id: string
          tool_id: string
          event_type: GraphPolicyEvent["eventType"]
          mode: GraphPolicyEvent["mode"]
          ts: number
          graph_state: GraphPolicyEvent["graphState"] | null
          outcome: GraphPolicyEvent["outcome"] | null
        }>(sql`
          SELECT id, session_id, message_id, tool_id, event_type, mode, ts, graph_state, outcome
          FROM codegraph_policy_events
          ${input?.sessionID !== undefined ? sql`WHERE session_id = ${input.sessionID}` : sql``}
          ORDER BY ts DESC, id DESC
          LIMIT ${input?.limit ?? 200}
        `)
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
        toolID: row.tool_id,
        eventType: row.event_type,
        mode: row.mode,
        ts: row.ts,
        ...(row.graph_state === null ? {} : { graphState: row.graph_state }),
        ...(row.outcome === null ? {} : { outcome: row.outcome }),
      }))
    })

    return Service.of({
      materialize: Effect.fn("AdaptedCatalog.materialize")(function* (input: MaterializeInput) {
        if (!input.model.capabilities.tools) return []
        const materialized = yield* input.registry.materialize(input.agent.permissions)
        const registered = input.registry.list()
        const recent = yield* db.all<{ tool_id: string }>(sql`
          SELECT DISTINCT tool_id FROM codegraph_tool_usage
          WHERE last_used_at >= unixepoch() - 86400
        `).pipe(Effect.orDie)
        const recentIDs = new Set(recent.map((row) => row.tool_id))
        const visibleIDs = new Set(materialized.definitions.map((definition) => definition.name))

        return [...registered.entries()]
          .map(([id, tool]) => {
            const definition = Tool.definition(id, tool)
            const visibility = tool.contract.visibility
            const tier: Tier = explicitlyAllowed(id, input.agent.permissions) || recentIDs.has(id)
              ? "hot"
              : visibility === "public"
                ? "warm"
                : "cold"
            return { tool: toAdapted(definition, tier), visible: visibleIDs.has(id) }
          })
          .filter((entry) => entry.tool.tier === "cold" || entry.visible)
          .map((entry) => entry.tool)
          .sort((a, b) => ({ hot: 0, warm: 1, cold: 2 })[a.tier] - ({ hot: 0, warm: 1, cold: 2 })[b.tier] || a.id.localeCompare(b.id))
      }),
      tier: (tool) => tool.tier,
      recordUsage,
      recordPolicyEvent,
      listPolicyEvents,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export * as AdaptedCatalog from "./adapted-catalog"

import { Context, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import type { ToolDefinition } from "@opencode-ai/llm"
import { Database } from "../database/database"
import type { AgentV2 } from "../agent"
import type { ModelV2 } from "../model"
import type { PermissionV2 } from "../permission"
import type { Interface as ToolRegistryInterface } from "../tool/registry"
import { Tool } from "../tool/tool"

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

export interface Interface {
  readonly materialize: (input: MaterializeInput) => Effect.Effect<ReadonlyArray<AdaptedTool>, never, never>
  readonly tier: (tool: AdaptedTool) => Tier
  readonly recordUsage: (toolID: string) => Effect.Effect<void, never, never>
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

    const recordUsage = Effect.fn("AdaptedCatalog.recordUsage")(function* (toolID: string) {
      yield* db.run(sql`
        INSERT INTO codegraph_tool_usage (tool_id, last_used_at, use_count)
        VALUES (${toolID}, unixepoch(), 1)
        ON CONFLICT(tool_id) DO UPDATE SET
          last_used_at = unixepoch(),
          use_count = codegraph_tool_usage.use_count + 1
      `).pipe(Effect.orDie)
    })

    return Service.of({
      materialize: Effect.fn("AdaptedCatalog.materialize")(function* (input: MaterializeInput) {
        if (!input.model.capabilities.tools) return []
        const materialized = yield* input.registry.materialize(input.agent.permissions)
        const registered = input.registry.list()
        const recent = yield* db.all<{ tool_id: string }>(sql`
          SELECT tool_id FROM codegraph_tool_usage
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
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export * as AdaptedCatalog from "./adapted-catalog"

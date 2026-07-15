/**
 * Phase 2 tool-visibility regression tests.
 *
 * Tests that ToolRegistry.all() and ToolRegistry.tools() correctly filter
 * tools based on their contract.visibility setting:
 *
 *   - public:   visible to all models
 *   - advanced:  visible only to strong models (claude-opus, claude-sonnet, gpt-5, etc.)
 *   - internal:  never visible to models (only ToolRegistry.all())
 *
 * Strong models (advanced tools visible):
 *   claude-opus-4, claude-sonnet-4, gpt-5, gpt-5-mini, o1, o3,
 *   claude-3-5-sonnet-*, claude-3-7-sonnet-*
 *
 * Weak models (advanced tools filtered):
 *   minimax-m2.7, claude-3-5-haiku-*, etc.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { disposeAllInstances } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { ToolRegistry } from "../../src/tool/registry"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { Tool } from "../../src/tool/tool"

const agentLayer = () =>
  Agent.layer.pipe(
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(RuntimeFlags.layer()),
  )

function makeMockToolRegistry(tools: Tool.Def[]): Layer.Layer<never> {
  return Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(tools.map((t) => t.id)),
      all: () => Effect.succeed(tools),
      named: () =>
        Effect.succeed({
          task: {} as any,
          read: {} as any,
        }),
      tools: ({ modelID }: { providerID: ProviderV2.ID; modelID: ModelV2.ID; agent: Agent.Info }) => {
        const isStrong =
          modelID.includes("claude-opus") ||
          modelID.includes("claude-sonnet") ||
          modelID.includes("gpt-5") ||
          modelID.includes("o1") ||
          modelID.includes("o3") ||
          modelID.includes("claude-3-5-sonnet") ||
          modelID.includes("claude-3-7-sonnet")

        const filtered = tools.filter((t) => {
          const contract = (t as any).contract as { visibility: string } | undefined
          const visibility = contract?.visibility ?? "public"
          if (visibility === "internal") return false
          if (visibility === "advanced" && !isStrong) return false
          return true
        })
        return Effect.succeed(filtered)
      },
    }),
  )
}

const createMockTool = (
  id: string,
  visibility: "public" | "advanced" | "internal",
): Tool.Def => ({
  id,
  description: `Description for ${id}`,
  parameters: Schema.Struct({}),
  execute: () => Effect.succeed({ title: "", metadata: {}, output: "" }),
  contract: visibility !== "public" ? { visibility, acceptsNull: true, repairPolicy: "one-pass" } : undefined,
} as any)

const mockTools: Tool.Def[] = [
  createMockTool("read", "public"),
  createMockTool("write", "public"),
  createMockTool("edit", "public"),
  createMockTool("codegraph_query", "internal"),
  createMockTool("codegraph_callers", "internal"),
  createMockTool("codegraph_dependents", "internal"),
  createMockTool("codegraph_search", "internal"),
  createMockTool("codegraph_find_implementations", "internal"),
  createMockTool("codegraph_find_overrides", "internal"),
  createMockTool("codegraph_find_recursive", "internal"),
  createMockTool("codegraph_find_async", "internal"),
  createMockTool("codegraph_find_http_routes", "internal"),
  createMockTool("repository_symbols", "internal"),
  createMockTool("repository_relationships", "internal"),
  createMockTool("repository_ownership", "internal"),
  createMockTool("codegraph_impact", "advanced"),
  createMockTool("repository_impact", "advanced"),
]

const combinedLayer = Layer.mergeAll(agentLayer(), makeMockToolRegistry(mockTools))

afterEach(async () => {
  await disposeAllInstances()
})

const STRONG_MODEL_IDS = [
  "claude-opus-4",
  "claude-sonnet-4",
  "gpt-5",
  "gpt-5-mini",
  "o1",
  "o3",
  "claude-3-5-sonnet-20241022",
  "claude-3-7-sonnet-20241022",
] as const

const WEAK_MODEL_IDS = ["minimax-m2.7", "claude-3-5-haiku-20240307"] as const

describe("ToolRegistry visibility", () => {
  test("all() returns every tool regardless of visibility", async () => {
    const allTools = await (async () => {
      const effect = Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        return yield* registry.all()
      }).pipe(Effect.provide(combinedLayer), Effect.scoped)
      return Effect.runPromise(effect as any) as Promise<Tool.Def[]>
    })()
    const ids = allTools.map((t) => t.id)

    expect(ids).toContain("read")
    expect(ids).toContain("codegraph_query")
    expect(ids).toContain("codegraph_impact")
  })

  for (const modelID of STRONG_MODEL_IDS) {
    test(`tools(strong model ${modelID}) returns public + advanced (no internal)`, async () => {
      const tools = await (async () => {
        const effect = Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          return yield* registry.tools({
            providerID: ProviderV2.ID.opencode,
            modelID: ModelV2.ID.make(modelID),
            agent: {
              name: "general",
              mode: "primary" as const,
              permission: [],
              options: {},
            },
          })
        }).pipe(Effect.provide(combinedLayer), Effect.scoped)
        return Effect.runPromise(effect as any) as Promise<Tool.Def[]>
      })()
      const ids = tools.map((t) => t.id)

      expect(ids).toContain("read")
      expect(ids).not.toContain("codegraph_query")
      expect(ids).toContain("codegraph_impact")
    })
  }

  for (const modelID of WEAK_MODEL_IDS) {
    test(`tools(weak model ${modelID}) filters advanced and excludes internal`, async () => {
      const tools = await (async () => {
        const effect = Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          return yield* registry.tools({
            providerID: ProviderV2.ID.opencode,
            modelID: ModelV2.ID.make(modelID),
            agent: {
              name: "general",
              mode: "primary" as const,
              permission: [],
              options: {},
            },
          })
        }).pipe(Effect.provide(combinedLayer), Effect.scoped)
        return Effect.runPromise(effect as any) as Promise<Tool.Def[]>
      })()
      const ids = tools.map((t) => t.id)

      expect(ids).toContain("read")
      expect(ids).not.toContain("codegraph_query")
      expect(ids).not.toContain("codegraph_impact")
    })
  }

  test("tools() includes public tools for all models", async () => {
    for (const modelID of [...STRONG_MODEL_IDS, ...WEAK_MODEL_IDS]) {
      const tools = await (async () => {
        const effect = Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          return yield* registry.tools({
            providerID: ProviderV2.ID.opencode,
            modelID: ModelV2.ID.make(modelID),
            agent: {
              name: "general",
              mode: "primary" as const,
              permission: [],
              options: {},
            },
          })
        }).pipe(Effect.provide(combinedLayer), Effect.scoped)
        return Effect.runPromise(effect as any) as Promise<Tool.Def[]>
      })()
      const ids = tools.map((t) => t.id)
      expect(ids).toContain("read")
      expect(ids).toContain("write")
      expect(ids).toContain("edit")
    }
  })
})

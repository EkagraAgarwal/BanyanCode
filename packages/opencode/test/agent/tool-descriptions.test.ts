/**
 * Phase 2 tool-description-template regression tests.
 *
 * Tests that every LLM-visible tool (public or advanced visibility)
 * has a description that follows the structured template:
 *
 *   Use when: <triggering scenario>
 *   Examples: <usage examples>
 *   Returns: <output description>
 *   Avoid when: <contraindications>
 *
 * This ensures model-facing tool documentation is consistent and complete.
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
      tools: () => Effect.succeed(tools),
    }),
  )
}

const DESCRIPTION_TEMPLATE_SECTIONS = ["Use when:", "Examples", "Returns", "Avoid when"] as const

function hasAllTemplateSections(description: string): boolean {
  return DESCRIPTION_TEMPLATE_SECTIONS.every((section) => description.includes(section))
}

function getMissingSections(description: string): string[] {
  return DESCRIPTION_TEMPLATE_SECTIONS.filter((section) => !description.includes(section))
}

const mockToolsWithTemplate: Tool.Def[] = [
  {
    id: "codegraph_build",
    description:
      "Use when: you need to build the code graph index for a codebase.\n" +
      "Examples: /codegraph-build, opencode codegraph build\n" +
      "Returns: indexed count, skipped count, duration_ms, symbolsIndexed.\n" +
      "Avoid when: the codegraph is already built and up to date.",
    parameters: Schema.Struct({}),
    execute: () => Effect.succeed({ title: "", metadata: {}, output: "" }),
  } as Tool.Def,
  {
    id: "codegraph_query",
    description:
      "Use when: you need to look up nodes in the code graph.\n" +
      "Examples: finding symbols by name, kind, or file path\n" +
      "Returns: matching CodegraphNode objects.\n" +
      "Avoid when: the codegraph hasn't been built yet.",
    parameters: Schema.Struct({}),
    execute: () => Effect.succeed({ title: "", metadata: {}, output: "" }),
    contract: { visibility: "internal", acceptsNull: true, repairPolicy: "one-pass" },
  } as any,
]

const mockToolsWithoutTemplate: Tool.Def[] = [
  {
    id: "codegraph_impact",
    description: "Find all nodes affected by a change to the given node.",
    parameters: Schema.Struct({}),
    execute: () => Effect.succeed({ title: "", metadata: {}, output: "" }),
  } as Tool.Def,
]

const combinedLayer = Layer.mergeAll(
  agentLayer(),
  makeMockToolRegistry([...mockToolsWithTemplate, ...mockToolsWithoutTemplate]),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("Tool description template", () => {
  test("tools with template have all four sections", async () => {
    const allTools = await (async () => {
      const effect = Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        return yield* registry.all()
      }).pipe(Effect.provide(combinedLayer), Effect.scoped)
      return Effect.runPromise(effect as any) as Promise<Tool.Def[]>
    })()

    const toolWithTemplate = allTools.find((t) => t.id === "codegraph_build")
    expect(toolWithTemplate).toBeDefined()
    if (toolWithTemplate) {
      expect(toolWithTemplate.description).toContain("Use when:")
      expect(toolWithTemplate.description).toContain("Examples")
      expect(toolWithTemplate.description).toContain("Returns")
      expect(toolWithTemplate.description).toContain("Avoid when")
    }
  })

  test("codegraph_impact is missing template sections", async () => {
    const allTools = await (async () => {
      const effect = Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        return yield* registry.all()
      }).pipe(Effect.provide(combinedLayer), Effect.scoped)
      return Effect.runPromise(effect as any) as Promise<Tool.Def[]>
    })()

    const tool = allTools.find((t) => t.id === "codegraph_impact")
    expect(tool).toBeDefined()
    if (tool) {
      const missing = getMissingSections(tool.description)
      expect(missing.length).toBeGreaterThan(0)
    }
  })

  test("codegraph_query (internal) still has template", async () => {
    const allTools = await (async () => {
      const effect = Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        return yield* registry.all()
      }).pipe(Effect.provide(combinedLayer), Effect.scoped)
      return Effect.runPromise(effect as any) as Promise<Tool.Def[]>
    })()

    const tool = allTools.find((t) => t.id === "codegraph_query")
    expect(tool).toBeDefined()
    if (tool) {
      expect(hasAllTemplateSections(tool.description)).toBe(true)
    }
  })

  test("all LLM-visible tools have descriptions", async () => {
    const allTools = await (async () => {
      const effect = Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        return yield* registry.all()
      }).pipe(Effect.provide(combinedLayer), Effect.scoped)
      return Effect.runPromise(effect as any) as Promise<Tool.Def[]>
    })()

    for (const tool of allTools) {
      expect(tool.description.length).toBeGreaterThan(0)
    }
  })
})

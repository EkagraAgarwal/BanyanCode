import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolCall } from "@opencode-ai/llm"
import { tmpdir } from "../fixture/tmpdir"
import {
  Input as ToolSearchInput,
  Output as ToolSearchOutput,
  makeToolSearchTool,
  name as toolSearchName,
} from "../../src/tool/tool-search"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Tools } from "../../src/tool/tools"
import { Service as ToolRegistry, defaultLayer as toolRegistryDefaultLayer } from "../../src/tool/registry"
import { ApplicationTools } from "../../src/tool/application-tools"
import { ToolOutputStore } from "../../src/tool-output-store"
import { Scope } from "effect"
import { AgentV2 } from "../../src/agent"
import {
  Service as AdaptedCatalog,
  defaultLayer as adaptedCatalogDefaultLayer,
} from "../../src/banyancode/adapted-catalog"
import type { PermissionV2 } from "../../src/permission"

process.env.BANYANCODE_ENABLE = "1"

const sessionID = randomUUID()
const messageID = randomUUID()

const makeContext = (): Tool.Context => ({
  sessionID: sessionID as Tool.Context["sessionID"],
  agent: "build" as Tool.Context["agent"],
  assistantMessageID: messageID as Tool.Context["assistantMessageID"],
  toolCallID: randomUUID(),
})

const makeCall = (input: unknown): ToolCall => ({
  type: "tool-call",
  id: randomUUID(),
  name: toolSearchName,
  input,
})

const mockPermission: PermissionV2.Interface = {
  assert: () => Effect.void,
  ask: () => Effect.void,
  reply: () => Effect.void,
  configured: () => Effect.void,
  list: () => Effect.succeed([]),
  get: () => Effect.void,
  forSession: () => Effect.void,
} as unknown as PermissionV2.Interface

describe("banyan_tool_search tool", () => {
  test("Input / Output / name are exported with correct shape", () => {
    expect(toolSearchName).toBe("banyan_tool_search")
    expect(ToolSearchInput.fields).toHaveProperty("query")
    expect(ToolSearchInput.fields).toHaveProperty("tier")
    expect(ToolSearchInput.fields).toHaveProperty("limit")
    expect(ToolSearchOutput.fields).toHaveProperty("query")
    expect(ToolSearchOutput.fields).toHaveProperty("hits")
  })

  test("ranks hot tools ahead of warm tools for matching query", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "ts.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const registryLayer = toolRegistryDefaultLayer.pipe(
      Layer.provide(ApplicationTools.layer),
      Layer.provide(ToolOutputStore.defaultLayer),
    )
    const catalogLayer = adaptedCatalogDefaultLayer.pipe(Layer.provide(dbLayer))

    const agent = AgentV2.Info.empty(AgentV2.ID.make("build"))
    const agentWithPermission = new AgentV2.Info({
      ...agent,
      permissions: [
        { action: "hot_search", resource: "*", effect: "allow" },
        { action: "warm_search", resource: "*", effect: "allow" },
      ],
    })

    const structured = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const tools = yield* Tools.Service
        const registry = yield* ToolRegistry
        const catalog = yield* AdaptedCatalog
        const scope = yield* Scope.make()
        yield* tools.register({
          hot_search: Tool.make({
            description: "search hot index",
            contract: { visibility: "public" },
            input: Schema.Struct({ q: Schema.String }),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: () => Effect.succeed({ ok: true }),
          }),
          warm_search: Tool.make({
            description: "search warm index",
            contract: { visibility: "public" },
            input: Schema.Struct({ q: Schema.String }),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: () => Effect.succeed({ ok: true }),
          }),
          other: Tool.make({
            description: "unrelated",
            contract: { visibility: "public" },
            input: Schema.Struct({ q: Schema.String }),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: () => Effect.succeed({ ok: true }),
          }),
        }).pipe(Scope.provide(scope))
        const tool = makeToolSearchTool({
          permission: mockPermission,
          catalog,
          registry,
          resolveAgent: () => Effect.succeed(agentWithPermission as AgentV2.Info | undefined),
          emptyAgent: (id) => AgentV2.Info.empty(AgentV2.ID.make(id)),
        })
        const result = yield* Tool.settle(tool, makeCall({ query: "search" }), makeContext())
        return result.structured
      }).pipe(Effect.provide(Layer.mergeAll(registryLayer, catalogLayer, dbLayer)), Effect.scoped),
    ) as Schema.Schema.Type<typeof ToolSearchOutput>

    const ids = structured.hits.map((hit) => hit.tool.id)
    expect(ids).toContain("hot_search")
    expect(ids).toContain("warm_search")
    expect(ids).not.toContain("other")
    const hotIndex = ids.indexOf("hot_search")
    const warmIndex = ids.indexOf("warm_search")
    expect(hotIndex).toBeLessThan(warmIndex)
  })

  test("tier filter restricts the search to a single tier", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "ts.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const registryLayer = toolRegistryDefaultLayer.pipe(
      Layer.provide(ApplicationTools.layer),
      Layer.provide(ToolOutputStore.defaultLayer),
    )
    const catalogLayer = adaptedCatalogDefaultLayer.pipe(Layer.provide(dbLayer))

    const agent = AgentV2.Info.empty(AgentV2.ID.make("build"))
    const agentWithPermission = new AgentV2.Info({
      ...agent,
      permissions: [
        { action: "hot_search", resource: "*", effect: "allow" },
      ],
    })

    const structured = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const tools = yield* Tools.Service
        const registry = yield* ToolRegistry
        const catalog = yield* AdaptedCatalog
        const scope = yield* Scope.make()
        yield* tools.register({
          hot_search: Tool.make({
            description: "hot search",
            contract: { visibility: "public" },
            input: Schema.Struct({ q: Schema.String }),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: () => Effect.succeed({ ok: true }),
          }),
          cold_search: Tool.make({
            description: "cold search",
            contract: { visibility: "internal" },
            input: Schema.Struct({ q: Schema.String }),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: () => Effect.succeed({ ok: true }),
          }),
        }).pipe(Scope.provide(scope))
        const tool = makeToolSearchTool({
          permission: mockPermission,
          catalog,
          registry,
          resolveAgent: () => Effect.succeed(agentWithPermission as AgentV2.Info | undefined),
          emptyAgent: (id) => AgentV2.Info.empty(AgentV2.ID.make(id)),
        })
        const result = yield* Tool.settle(tool, makeCall({ query: "search", tier: "cold" }), makeContext())
        return result.structured
      }).pipe(Effect.provide(Layer.mergeAll(registryLayer, catalogLayer, dbLayer)), Effect.scoped),
    ) as Schema.Schema.Type<typeof ToolSearchOutput>

    expect(structured.tier).toBe("cold")
    expect(structured.hits.every((hit) => hit.tool.tier === "cold")).toBe(true)
    expect(structured.hits.some((hit) => hit.tool.id === "cold_search")).toBe(true)
  })

  test("empty query returns _diagnostic=empty-query with zero hits", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "ts.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const registryLayer = toolRegistryDefaultLayer.pipe(
      Layer.provide(ApplicationTools.layer),
      Layer.provide(ToolOutputStore.defaultLayer),
    )
    const catalogLayer = adaptedCatalogDefaultLayer.pipe(Layer.provide(dbLayer))

    const structured = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const registry = yield* ToolRegistry
        const catalog = yield* AdaptedCatalog
        const agent = AgentV2.Info.empty(AgentV2.ID.make("build"))
        const tool = makeToolSearchTool({
          permission: mockPermission,
          catalog,
          registry,
          resolveAgent: () => Effect.succeed(agent as AgentV2.Info | undefined),
          emptyAgent: (id) => AgentV2.Info.empty(AgentV2.ID.make(id)),
        })
        const result = yield* Tool.settle(tool, makeCall({ query: "   " }), makeContext())
        return result.structured
      }).pipe(Effect.provide(Layer.mergeAll(registryLayer, catalogLayer, dbLayer)), Effect.scoped),
    ) as Schema.Schema.Type<typeof ToolSearchOutput>

    expect(structured.total).toBe(0)
    expect(structured._diagnostic).toBe("empty-query")
  })
})

import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer, Schema, Scope } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { tmpdir } from "../fixture/tmpdir"
import {
  Service as AdaptedCatalog,
  defaultLayer as adaptedCatalogDefaultLayer,
} from "../../src/banyancode/adapted-catalog"
import { Service as ToolRegistry, defaultLayer as toolRegistryDefaultLayer } from "../../src/tool/registry"
import { ToolOutputStore } from "../../src/tool-output-store"
import { ApplicationTools } from "../../src/tool/application-tools"
import { Tools } from "../../src/tool/tools"
import { Tool } from "../../src/tool/tool"
import { AgentV2 } from "../../src/agent"
import { ModelV2 } from "../../src/model"
import type { PermissionV2 } from "../../src/permission"

process.env.BANYANCODE_ENABLE = "1"

const echoTool = (visibility: "public" | "advanced" | "internal" = "public") =>
  Tool.make({
    description: `echo tool with ${visibility} visibility`,
    contract: { visibility },
    input: Schema.Struct({ query: Schema.String }),
    output: Schema.Struct({ echo: Schema.String }),
    execute: ({ query }) => Effect.succeed({ echo: query }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.echo }],
  })

const buildAgent = (permissions: PermissionV2.Ruleset = []) => {
  const agent = AgentV2.Info.empty(AgentV2.ID.make("build"))
  return new AgentV2.Info({ ...agent, permissions })
}

const buildModel = (tools: boolean) => {
  const model = ModelV2.Info.empty("stub" as never, "stub" as never)
  return new ModelV2.Info({ ...model, capabilities: { tools, input: [], output: [] } })
}

const setupLayers = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const registryLayer = toolRegistryDefaultLayer.pipe(
    Layer.provide(ApplicationTools.layer),
    Layer.provide(ToolOutputStore.defaultLayer),
  )
  const catalogLayer = adaptedCatalogDefaultLayer.pipe(Layer.provide(dbLayer))
  const all = Layer.mergeAll(registryLayer, catalogLayer, dbLayer)
  return { all, dbLayer }
}

const seedUsage = async (
  dbPath: string,
  entries: Array<{ toolID: string; lastUsedAt: number; useCount: number }>,
) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* DatabaseMigration.apply(db)
      for (const entry of entries) {
        yield* db.run(sql`
          INSERT INTO codegraph_tool_usage (tool_id, last_used_at, use_count)
          VALUES (${entry.toolID}, ${entry.lastUsedAt}, ${entry.useCount})
          ON CONFLICT(tool_id) DO UPDATE SET
            last_used_at = excluded.last_used_at,
            use_count = excluded.use_count
        `)
      }
    }).pipe(Effect.provide(Database.layerFromPath(dbPath)), Effect.scoped),
  )
}

describe("AdaptedCatalog", () => {
  test("public tool without usage is warm, internal tool is cold", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "catalog.db")
    const { all } = setupLayers(dbPath)
    await seedUsage(dbPath, [])

    const tiers = await Effect.runPromise(
      Effect.gen(function* () {
        const tools = yield* Tools.Service
        const catalog = yield* AdaptedCatalog
        const registry = yield* ToolRegistry
        const scope = yield* Scope.make()
        yield* tools.register({ warm_demo: echoTool("public"), cold_demo: echoTool("internal") }).pipe(
          Scope.provide(scope),
        )
        const result = yield* catalog.materialize({
          registry,
          agent: buildAgent(),
          model: buildModel(true),
        })
        const found = Object.fromEntries(result.map((tool: { id: string; tier: string }) => [tool.id, tool.tier]))
        return found as Record<string, string>
      }).pipe(Effect.provide(all), Effect.scoped),
    )
    expect(tiers["warm_demo"]).toBe("warm")
    expect(tiers["cold_demo"]).toBe("cold")
  })

  test("explicit permission allow bumps tool to hot", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "catalog.db")
    const { all } = setupLayers(dbPath)
    await seedUsage(dbPath, [])

    const tier = await Effect.runPromise(
      Effect.gen(function* () {
        const tools = yield* Tools.Service
        const catalog = yield* AdaptedCatalog
        const registry = yield* ToolRegistry
        const scope = yield* Scope.make()
        yield* tools.register({ hot_via_perm: echoTool("public") }).pipe(Scope.provide(scope))
        const result = yield* catalog.materialize({
          registry,
          agent: buildAgent([{ action: "hot_via_perm", resource: "*", effect: "allow" }]),
          model: buildModel(true),
        })
        const found = result.find((tool: { id: string }) => tool.id === "hot_via_perm")
        return found?.tier
      }).pipe(Effect.provide(all), Effect.scoped),
    )
    expect(tier).toBe("hot")
  })

  test("recent usage within 24h bumps a warm tool to hot", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "catalog.db")
    const { all } = setupLayers(dbPath)
    const now = Math.floor(Date.now() / 1000)
    await seedUsage(dbPath, [{ toolID: "warm_demo", lastUsedAt: now - 1800, useCount: 7 }])

    const tier = await Effect.runPromise(
      Effect.gen(function* () {
        const tools = yield* Tools.Service
        const catalog = yield* AdaptedCatalog
        const registry = yield* ToolRegistry
        const scope = yield* Scope.make()
        yield* tools.register({ warm_demo: echoTool("public") }).pipe(Scope.provide(scope))
        const result = yield* catalog.materialize({ registry, agent: buildAgent(), model: buildModel(true) })
        const found = result.find((tool: { id: string }) => tool.id === "warm_demo")
        return found?.tier
      }).pipe(Effect.provide(all), Effect.scoped),
    )
    expect(tier).toBe("hot")
  })

  test("model without tool capability returns empty catalog", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "catalog.db")
    const { all } = setupLayers(dbPath)
    await seedUsage(dbPath, [])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* AdaptedCatalog
        const registry = yield* ToolRegistry
        return yield* catalog.materialize({ registry, agent: buildAgent(), model: buildModel(false) })
      }).pipe(Effect.provide(all), Effect.scoped),
    )
    expect(result).toEqual([])
  })

  test("recordUsage increments use_count, stamps session_id, and keeps lifetime aggregates", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "catalog.db")
    const { all } = setupLayers(dbPath)

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* AdaptedCatalog
        yield* catalog.recordUsage("t1", "ses_a")
        yield* catalog.recordUsage("t1", "ses_a")
        yield* catalog.recordUsage("t2", "ses_b")
        const { db } = yield* Database.Service
        return yield* db.all<{ tool_id: string; session_id: string | null; use_count: number }>(
          sql`SELECT tool_id, session_id, use_count FROM codegraph_tool_usage`,
        )
      }).pipe(Effect.provide(all), Effect.scoped),
    )
    const t1 = rows.find((row) => row.tool_id === "t1")
    const t2 = rows.find((row) => row.tool_id === "t2")
    expect(t1).toEqual({ tool_id: "t1", session_id: "ses_a", use_count: 2 })
    expect(t2).toEqual({ tool_id: "t2", session_id: "ses_b", use_count: 1 })
  })

  test("tier accessor returns the stored tier", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "catalog.db")
    const { all } = setupLayers(dbPath)

    const tier = await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* AdaptedCatalog
        return catalog.tier({ id: "x", description: "x", tier: "hot", schema: {} })
      }).pipe(Effect.provide(all), Effect.scoped),
    )
    expect(tier).toBe("hot")
  })
})

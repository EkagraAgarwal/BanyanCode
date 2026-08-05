import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolCatalog } from "@opencode-ai/core/tool/tool-catalog"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Banyan } from "../../src/banyancode"
import { BanyanToolsManifest } from "../../src/banyancode/banyan-tools-manifest"

process.env.BANYANCODE_ENABLE = "1"

// P7 parity: the manifest is NOT the visibility authority — each tool's
// `Tool.make({ contract: { visibility } })` is. This layer registers every
// banyan tool through `banyanToolLayer()` with stubbed service deps (the
// location layers only *yield* the services at build time; nothing executes),
// so we can read each registered tool's resolved contract and assert the
// manifest lists agree with it.
const deps = Layer.mergeAll(
  Layer.succeed(PermissionV2.Service, {} as never),
  Layer.succeed(Banyan.CodegraphRepo, {} as never),
  Layer.succeed(Banyan.CodegraphAnalyzer, {} as never),
  Layer.succeed(Banyan.CodegraphReadiness, {} as never),
  Layer.succeed(Banyan.CodegraphBuildService, {} as never),
  Layer.succeed(Banyan.RepositoryIntelligence, {} as never),
  Layer.succeed(Banyan.StructuralQueries, {} as never),
  Layer.succeed(Banyan.Search, {} as never),
  Layer.succeed(Banyan.EditPlanner, {} as never),
  Layer.succeed(Banyan.MemoryRepo, {} as never),
  Layer.succeed(Banyan.MemoryService, {} as never),
  Layer.succeed(Banyan.SubagentBus, {} as never),
  Layer.succeed(Banyan.SubagentMessagesRepo, {} as never),
  Layer.succeed(Banyan.MeshCoordinator, {} as never),
  Layer.succeed(Banyan.SystemMonitorService, {} as never),
  Layer.succeed(Banyan.RepoMapService, {} as never),
  Layer.succeed(Banyan.AdaptedCatalog, {} as never),
  Layer.succeed(Banyan.VerifierService, {} as never),
  FetchHttpClient.layer,
)

const toolLayer = BanyanToolsManifest.banyanToolLayer().pipe(
  Layer.provideMerge(deps),
  Layer.provideMerge(
    ToolCatalog.defaultLayer.pipe(
      Layer.provide(ApplicationTools.layer),
      Layer.provide(ToolOutputStore.defaultLayer),
    ),
  ),
)

describe("BanyanToolsManifest ↔ contract parity (P7)", () => {
  test("every BANYAN_INTERNAL_TOOL_IDS entry registers with a non-public contract", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* ToolCatalog.Service
        const listed = yield* catalog.list()

        expect(BanyanToolsManifest.BANYAN_INTERNAL_TOOL_IDS.length).toBeGreaterThan(0)
        for (const id of BanyanToolsManifest.BANYAN_INTERNAL_TOOL_IDS) {
          const tool = listed.get(id)
          expect(tool, `internal tool "${id}" is not registered`).toBeDefined()
          if (!tool) continue
          expect(
            Tool.contractOf(tool).visibility,
            `internal tool "${id}" must NOT have a public contract (manifest is not the visibility authority)`,
          ).not.toBe("public")
        }
      }).pipe(Effect.provide(toolLayer), Effect.scoped),
    )
  })

  test("every BANYAN_PUBLIC_TOOL_IDS entry registers with a public contract", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* ToolCatalog.Service
        const listed = yield* catalog.list()

        expect(BanyanToolsManifest.BANYAN_PUBLIC_TOOL_IDS.length).toBeGreaterThan(0)
        for (const id of BanyanToolsManifest.BANYAN_PUBLIC_TOOL_IDS) {
          const tool = listed.get(id)
          expect(tool, `public tool "${id}" is not registered`).toBeDefined()
          if (!tool) continue
          expect(
            Tool.contractOf(tool).visibility,
            `public tool "${id}" must have a public contract`,
          ).toBe("public")
        }
      }).pipe(Effect.provide(toolLayer), Effect.scoped),
    )
  })

  test("repository_impact is public-contract and therefore absent from the internal list", async () => {
    expect(BanyanToolsManifest.BANYAN_INTERNAL_TOOL_IDS).not.toContain("repository_impact")
    await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* ToolCatalog.Service
        const listed = yield* catalog.list()
        const impact = listed.get("repository_impact")
        expect(impact).toBeDefined()
        if (impact) {
          expect(Tool.contractOf(impact).visibility).toBe("public")
        }
      }).pipe(Effect.provide(toolLayer), Effect.scoped),
    )
  })
})

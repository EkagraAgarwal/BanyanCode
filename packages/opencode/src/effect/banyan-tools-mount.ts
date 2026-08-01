export * as BanyanToolsMount from "./banyan-tools-mount"

import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AppProcess } from "@opencode-ai/core/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2 } from "@opencode-ai/core/event"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { Tools } from "@opencode-ai/core/tool/tools"
import { ToolCatalog } from "@opencode-ai/core/tool/tool-catalog"
import { Banyan } from "@opencode-ai/core/banyancode"
import { BanyanToolsManifest } from "@opencode-ai/core/banyancode/banyan-tools-manifest"
import { Permission } from "@/permission"
import { PermissionBridge } from "./permission-bridge"
import { InstanceRef } from "./instance-ref"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

const databaseLayer = Database.defaultLayer

const codegraphRepoLayer = Banyan.codegraphRepoDefaultLayer.pipe(Layer.provide(databaseLayer))

const codegraphBuildServiceLayer = Banyan.codegraphBuildServiceDefaultLayer.pipe(
  Layer.provide(Banyan.banyanConfigServiceDefaultLayer),
  Layer.provide(PluginV2.locationLayer),
  Layer.provide(Layer.mergeAll(FSUtil.defaultLayer, databaseLayer, EventV2.defaultLayer)),
)

const codegraphReadinessLayer = Banyan.codegraphReadinessDefaultLayer.pipe(
  Layer.provide(Banyan.banyanConfigServiceDefaultLayer),
  Layer.provide(PluginV2.locationLayer),
  Layer.provide(Layer.mergeAll(FSUtil.defaultLayer, databaseLayer, EventV2.defaultLayer)),
)

const meshCoordinatorLayer = Banyan.meshCoordinatorDefaultLayer.pipe(
  Layer.provide(Banyan.subagentReviewRequestsRepoDefaultLayer),
  Layer.provide(Banyan.banyanConfigServiceDefaultLayer),
  Layer.provide(Banyan.maxSubagentsLayer.pipe(Layer.provide(Banyan.banyanConfigServiceDefaultLayer))),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(databaseLayer),
)

const systemMonitorLayer = Banyan.systemMonitorDefaultLayer.pipe(
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
)

const subagentBusLayer = Banyan.subagentBusLayer.pipe(
  Layer.provideMerge(Banyan.subagentMessagesRepoDefaultLayer.pipe(Layer.provide(databaseLayer))),
)

const repositoryIntelligenceLayer = Banyan.repositoryIntelligenceDefaultLayer.pipe(
  Layer.provide(databaseLayer),
)

const repoMapLayer = Banyan.repoMapServiceDefaultLayer.pipe(
  Layer.provide(codegraphRepoLayer),
)

const adaptedCatalogLayer = Banyan.adaptedCatalogDefaultLayer.pipe(
  Layer.provide(databaseLayer),
)

// Phase 6 (Verifier): the verifier service shell-outs to bun/bunx + reads
// banyancode.json for command overrides + writes to verification_runs. Wire
// the AppProcess + BanyanConfig + VerificationRepo deps here so the new
// `banyan_typecheck` / `banyan_test` / `banyan_lint` tools register cleanly
// alongside the rest of the BanyanToolCatalog.
const verifierLayer = Banyan.verifierServiceDefaultLayer.pipe(
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(Banyan.banyanConfigServiceDefaultLayer),
  Layer.provide(Banyan.verificationRepoDefaultLayer.pipe(Layer.provide(databaseLayer))),
)

export const banyanToolDepsLayer = Layer.mergeAll(
  PermissionBridge.layer.pipe(Layer.provide(Permission.defaultLayer)),
  FetchHttpClient.layer,
  Layer.succeed(
    Banyan.WorktreeContext,
    () =>
      Effect.gen(function* () {
        const inst = yield* InstanceRef
        return inst?.worktree
      }),
  ),
  codegraphRepoLayer,
  Banyan.codegraphAnalyzerDefaultLayer.pipe(Layer.provide(codegraphRepoLayer)),
  Banyan.searchDefaultLayer.pipe(Layer.provide(codegraphRepoLayer)),
  Banyan.structuralQueriesDefaultLayer.pipe(Layer.provide(codegraphRepoLayer)),
  repositoryIntelligenceLayer,
  Banyan.editPlannerDefaultLayer.pipe(
    Layer.provide(Banyan.codegraphAnalyzerDefaultLayer.pipe(Layer.provide(codegraphRepoLayer))),
    Layer.provide(codegraphRepoLayer),
  ),
  Banyan.memoryRepoDefaultLayer.pipe(Layer.provide(databaseLayer)),
  Banyan.memoryServiceDefaultLayer.pipe(Layer.provide(databaseLayer)),
  Banyan.goalRepoDefaultLayer.pipe(Layer.provide(databaseLayer)),
  Banyan.goalServiceDefaultLayer.pipe(Layer.provide(databaseLayer)),
  meshCoordinatorLayer,
  systemMonitorLayer,
  subagentBusLayer,
  codegraphBuildServiceLayer,
  codegraphReadinessLayer,
  repoMapLayer,
  adaptedCatalogLayer,
  verifierLayer,
)

const registrationLayer = BanyanToolsManifest.banyanToolLayer().pipe(Layer.provide(banyanToolDepsLayer))

export const registerBanyanTools = Effect.gen(function* () {
  if (!banyancodeEnabled()) return

  const toolsOption = yield* Effect.serviceOption(Tools.Service)
  if (toolsOption._tag === "None") return

  const catalogOption = yield* Effect.serviceOption(ToolCatalog.Service)
  if (catalogOption._tag === "None") return

  const registered = yield* catalogOption.value.list()
  const missing = BanyanToolsManifest.BANYAN_PUBLIC_TOOL_IDS.filter((id) => !registered.has(id))
  if (missing.length > 0) {
    return yield* Effect.die(
      new Error(
        `BanyanToolsMount: BanyanCode is enabled but the following public tools failed to register: [${missing.join(", ")}]. ` +
          `Check banyan-tools-mount.ts deps and banyanToolLayer() composition.`,
      ),
    )
  }
})

export const attachToCatalog = <E, R>(catalogLayer: Layer.Layer<ToolCatalog.Service | Tools.Service, E, R>) =>
  registrationLayer.pipe(
    Layer.provide(catalogLayer),
    Layer.provideMerge(catalogLayer),
    Layer.provideMerge(Layer.effectDiscard(registerBanyanTools)),
  ) as Layer.Layer<ToolCatalog.Service | Tools.Service, E, R>

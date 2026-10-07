export * as BanyanToolsMount from "./banyan-tools-mount"

import { Effect, Layer } from "effect"
import path from "node:path"
import { FetchHttpClient } from "effect/unstable/http"
import { AppProcess } from "@opencode-ai/core/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { sanitizeRoot as sanitizeDbRoot } from "@opencode-ai/core/database/banyan-db-path"
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
import { registerDisposer } from "./instance-registry"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

// Root-keyed Database layers for the codegraph bundle: derive from the
// canonical workspace root (realpath hash + channel suffix via
// Database.layerFromRoot, so the channel suffix is preserved), never the
// cwd-keyed Database.defaultLayer. Cached per canonical root so roots A and
// B stay isolated and repeat lookups share one layer. Entries are dropped by
// disposeWorkspaceLayers, which runs on workspace dispose (see below).
const dbLayerCache = new Map<string, Layer.Layer<Database.Service>>()

export const canonicalDbRoot = (root: string): string => sanitizeDbRoot(root)

export const databaseLayerForRoot = (root: string): Layer.Layer<Database.Service> => {
  const canonical = canonicalDbRoot(path.resolve(root))
  const hit = dbLayerCache.get(canonical)
  if (hit) return hit
  const next = Database.layerFromRoot(canonical)
  dbLayerCache.set(canonical, next)
  return next
}

export const invalidateDatabaseLayer = (root: string): void => {
  dbLayerCache.delete(canonicalDbRoot(path.resolve(root)))
}

// Wrong-store guard: an indexed_root that does not match the canonical root
// means the caller opened the wrong DB file. Fail so the caller re-resolves
// via databaseLayerForRoot — never rebuild into the wrong store.
export const assertSameStoreOrFail = (canonicalRoot: string, indexedRoot: string | undefined): void => {
  if (!indexedRoot) return
  if (canonicalDbRoot(indexedRoot) !== canonicalDbRoot(canonicalRoot)) {
    throw new Error(
      `BanyanToolsMount: indexed_root mismatch (expected ${canonicalDbRoot(canonicalRoot)}, found ${canonicalDbRoot(indexedRoot)}). Wrong store — re-resolve via databaseLayerForRoot, not rebuild.`,
    )
  }
}

// One in-flight readiness per canonical root. Core readiness dedupes its own
// ensureReady; this covers opencode-local kickoffs so concurrent callers for
// the same root share one promise instead of racing.
const readinessInflight = new Map<string, Promise<unknown>>()

export const dedupeReadinessForRoot = <T>(root: string, run: () => Promise<T>): Promise<T> => {
  const key = canonicalDbRoot(path.resolve(root))
  const hit = readinessInflight.get(key)
  if (hit) return hit as Promise<T>
  const next = run().finally(() => {
    if (readinessInflight.get(key) === next) readinessInflight.delete(key)
  })
  readinessInflight.set(key, next)
  return next
}

export const disposeWorkspaceLayers = (root: string): void => {
  const key = canonicalDbRoot(path.resolve(root))
  dbLayerCache.delete(key)
  readinessInflight.delete(key)
}

export const __test = { dbLayerCache, readinessInflight }

registerDisposer(async (directory) => {
  disposeWorkspaceLayers(directory)
})

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

const codegraphBootstrapLayer = Banyan.codegraphBootstrapDefaultLayer.pipe(
  Layer.provide(codegraphReadinessLayer),
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
  codegraphBootstrapLayer,
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

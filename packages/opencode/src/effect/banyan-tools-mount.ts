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
import { resolveWorkspaceRoot } from "@opencode-ai/core/banyancode/workspace-root"
import { Permission } from "@/permission"
import { PermissionBridge } from "./permission-bridge"
import { InstanceRef } from "./instance-ref"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

// Graph DB is bound to the canonical workspace root (explicit tool input →
// session `WorktreeContext` → cwd/repo-root fallback), never to
// `process.cwd()` at server start. Every graph service below consumes this
// root-bound Database so slash commands, agent tool calls,
// /global/codegraph-status, and TUI progress all resolve the SAME DB file
// and build state when the server was launched from a directory that differs
// from the selected worktree.
const rootBoundDatabaseLayer = Layer.unwrap(
  Effect.gen(function* () {
    const root = yield* resolveWorkspaceRoot({})
    return Database.layerFromRoot(root)
  }),
)

// Non-graph services (session store, memory, goals, mesh, verifier) keep the
// process-wide cwd-derived DB — their identity is not tied to the codegraph
// root.
const databaseLayer = Database.defaultLayer

/**
 * Wires `WorktreeContext` from the ambient instance worktree so
 * `resolveWorkspaceRoot` (used by every graph tool + the root-bound DB)
 * resolves the SELECTED worktree rather than the server's cwd. The reference
 * has a `undefined` defaultValue, so runtimes that do not provide this layer
 * degrade to the cwd/repo-root fallback instead of failing.
 */
export const worktreeContextLayer = Layer.succeed(
  Banyan.WorktreeContext,
  () =>
    Effect.gen(function* () {
      const inst = yield* InstanceRef
      return inst?.worktree
    }),
)

export const codegraphRepoLayer = Banyan.codegraphRepoLayer.pipe(Layer.provide(rootBoundDatabaseLayer))

const codegraphAnalyzerLayer = Banyan.codegraphAnalyzerLayer.pipe(Layer.provide(codegraphRepoLayer))
const searchLayer = Banyan.searchLayer.pipe(Layer.provide(codegraphRepoLayer))
const structuralQueriesLayer = Banyan.structuralQueriesLayer.pipe(Layer.provide(codegraphRepoLayer))

// Built from the raw indexer layer (not `codegraphIndexerDefaultLayer`,
// which binds `CodegraphRepo.defaultLayer` / `Database.defaultLayer` to
// process.cwd()) so the indexer's WAL checkpoints and transactions land on
// the root-bound DB.
const codegraphIndexerLayer = Banyan.codegraphIndexerLayer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(codegraphRepoLayer),
  Layer.provide(rootBoundDatabaseLayer),
)

export const codegraphBuildServiceDefaultLayer = Banyan.codegraphBuildServiceLayer.pipe(
  Layer.provide(codegraphIndexerLayer),
  Layer.provide(codegraphRepoLayer),
  Layer.provide(Banyan.banyanConfigServiceDefaultLayer),
  Layer.provide(PluginV2.locationLayer),
  Layer.provide(Layer.mergeAll(FSUtil.defaultLayer, rootBoundDatabaseLayer, EventV2.defaultLayer)),
)

// Readiness + bootstrap are built against the AMBIENT
// CodegraphBuildService/CodegraphReadiness rather than chaining their own
// private copies. The facade layers below output AND provide the same layer
// nodes, so Effect memoizes them into ONE root-bound build instance, one
// readiness instance, and one bootstrap instance. That is what lets slash
// commands, agent tool calls, /global/codegraph-status, and the TUI progress
// bridge observe the same build state instead of racing duplicate services.
export const codegraphReadinessDefaultLayer = Layer.mergeAll(
  codegraphBuildServiceDefaultLayer,
  Banyan.codegraphReadinessLayer,
).pipe(
  Layer.provide(codegraphBuildServiceDefaultLayer),
  Layer.provide(codegraphRepoLayer),
  Layer.provide(Banyan.banyanConfigServiceDefaultLayer),
  Layer.provide(PluginV2.locationLayer),
  Layer.provide(Layer.mergeAll(FSUtil.defaultLayer, rootBoundDatabaseLayer, EventV2.defaultLayer)),
)

export const codegraphBootstrapDefaultLayer = Layer.mergeAll(
  codegraphReadinessDefaultLayer,
  Banyan.codegraphBootstrapLayer,
).pipe(
  Layer.provide(codegraphReadinessDefaultLayer),
  Layer.provide(Banyan.banyanConfigServiceDefaultLayer),
  Layer.provide(FSUtil.defaultLayer),
)

const repositoryIntelligenceLayer = Banyan.repositoryIntelligenceLayer.pipe(
  Layer.provide(Banyan.gitDefaultLayer),
  Layer.provide(codegraphRepoLayer),
)

const repoMapLayer = Banyan.repoMapServiceLayer.pipe(Layer.provide(codegraphRepoLayer))
const adaptedCatalogLayer = Banyan.adaptedCatalogLayer.pipe(Layer.provide(rootBoundDatabaseLayer))
const editPlannerLayer = Banyan.editPlannerLayer.pipe(
  Layer.provide(codegraphAnalyzerLayer),
  Layer.provide(codegraphRepoLayer),
)

/**
 * Root-aware facade over the graph read-path services (repo + derived read
 * services). Both AppRuntime (app-runtime.ts) and the HTTP server
 * (server.ts) merge this facade, and separately mount the root-bound
 * `codegraphBuildServiceDefaultLayer` / `codegraphReadinessDefaultLayer` /
 * `codegraphBootstrapDefaultLayer` seams, so every execution path shares one
 * root-bound graph identity and build state. `worktreeContextLayer` rides
 * along so `resolveWorkspaceRoot` in tools + the root-bound DB resolves the
 * instance worktree instead of the server cwd.
 */
export const banyanGraphOwnerLayer = Layer.mergeAll(
  worktreeContextLayer,
  codegraphRepoLayer,
  codegraphAnalyzerLayer,
  searchLayer,
  structuralQueriesLayer,
  repositoryIntelligenceLayer,
  repoMapLayer,
  adaptedCatalogLayer,
  editPlannerLayer,
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
  banyanGraphOwnerLayer,
  codegraphBuildServiceDefaultLayer,
  codegraphReadinessDefaultLayer,
  codegraphBootstrapDefaultLayer,
  Banyan.memoryRepoDefaultLayer.pipe(Layer.provide(databaseLayer)),
  Banyan.memoryServiceDefaultLayer.pipe(Layer.provide(databaseLayer)),
  Banyan.goalRepoDefaultLayer.pipe(Layer.provide(databaseLayer)),
  Banyan.goalServiceDefaultLayer.pipe(Layer.provide(databaseLayer)),
  meshCoordinatorLayer,
  systemMonitorLayer,
  subagentBusLayer,
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

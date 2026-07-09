import { Layer, ManagedRuntime, Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AppProcess } from "@opencode-ai/core/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { attach } from "./run-service"
import * as Observability from "@opencode-ai/core/observability"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Storage } from "@/storage/storage"
import { Snapshot } from "@/snapshot"
import { Plugin } from "@/plugin"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"
import { ProviderAuth } from "@/provider/auth"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { PermissionBridge } from "./permission-bridge"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionProcessor } from "@/session/processor"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionPrompt } from "@/session/prompt"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Command } from "@/command"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Format } from "@/format"
import { InstanceLayer } from "@/project/instance-layer"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { Workspace } from "@/control-plane/workspace"
import { Worktree } from "@/worktree"
import { Installation } from "@/installation"
import { ShareNext } from "@/share/share-next"
import { SessionShare } from "@/share/session"
import { Npm } from "@opencode-ai/core/npm"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Banyan } from "@opencode-ai/core/banyancode"
import { EventV2 } from "@opencode-ai/core/event"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { ToolCatalog } from "@opencode-ai/core/tool/tool-catalog"
import * as AiSdkTransportModule from "./transport-ai-sdk"
import { applyCodegraphBuildBridge } from "./banyancode-codegraph-bridge"
import { applyFilesystemBridge } from "./banyancode-filesystem-bridge"
import { applySystemMonitorBridge } from "./banyancode-system-bridge"

export const AppLayer = Layer.mergeAll(
  Npm.defaultLayer,
  FSUtil.defaultLayer,
  Database.defaultLayer,
  Auth.defaultLayer,
  Account.defaultLayer,
  Config.defaultLayer,
  Git.defaultLayer,
  Storage.defaultLayer,
  Snapshot.defaultLayer,
  Plugin.defaultLayer,
  ModelsDev.defaultLayer,
  Provider.defaultLayer,
  ProviderAuth.defaultLayer,
  Agent.defaultLayer,
  Skill.defaultLayer,
  Discovery.defaultLayer,
  Question.defaultLayer,
  Permission.defaultLayer,
  Todo.defaultLayer,
  Session.defaultLayer,
  SessionStatus.defaultLayer,
  BackgroundJob.defaultLayer,
  RuntimeFlags.defaultLayer,
  EventV2Bridge.defaultLayer,
  EventV2.defaultLayer,
  Banyan.subagentBusDefaultLayer,
  Banyan.subagentPlansRepoDefaultLayer,
  Banyan.systemMonitorDefaultLayer,
  SessionRunState.defaultLayer,
  SessionProcessor.defaultLayer,
  SessionCompaction.defaultLayer,
  SessionRevert.defaultLayer,
  SessionSummary.defaultLayer,
  SessionPrompt.defaultLayer,
  Instruction.defaultLayer,
  LLM.defaultLayer,
  LSP.defaultLayer,
  MCP.defaultLayer,
  McpAuth.defaultLayer,
  Command.defaultLayer,
  Truncate.defaultLayer,
  ToolRegistry.defaultLayer,
  Format.defaultLayer,
  Project.defaultLayer,
  Vcs.defaultLayer,
  Workspace.defaultLayer,
  Worktree.appLayer,
  Installation.defaultLayer,
  ShareNext.defaultLayer,
  SessionShare.defaultLayer,
).pipe(
  Layer.provideMerge(Ripgrep.defaultLayer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(InstanceLayer.layer),
  Layer.provideMerge(Observability.layer),
  Layer.provideMerge(Banyan.codegraphRepoDefaultLayer),
  Layer.provideMerge(Banyan.codegraphStalenessDefaultLayer),
  Layer.provideMerge(Banyan.editPlannerDefaultLayer),
  Layer.provideMerge(Banyan.codegraphAnalyzerDefaultLayer),
  Layer.provideMerge(
    Banyan.banyanFilesystemDefaultLayer.pipe(
      Layer.provide(EventV2.defaultLayer),
    ),
  ),
  Layer.provideMerge(Banyan.searchDefaultLayer),
  Layer.provideMerge(Banyan.structuralQueriesDefaultLayer),
  Layer.provideMerge(
    Banyan.codegraphBuildServiceDefaultLayer.pipe(
      Layer.provide(Banyan.banyanConfigServiceDefaultLayer),
      Layer.provide(PluginV2.locationLayer),
      Layer.provide(Layer.mergeAll(FSUtil.defaultLayer, Database.defaultLayer, EventV2.defaultLayer)),
    ),
  ),
  Layer.provideMerge(
    Banyan.repositoryIntelligenceDefaultLayer.pipe(
      Layer.provide(Database.defaultLayer),
    ),
  ),
  Layer.provideMerge(
    Banyan.toolRegistryDefaultLayer.pipe(
      Layer.provide(Permission.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provide(FSUtil.defaultLayer),
    ),
  ),
  Layer.provideMerge(
    Banyan.toolCatalogDefaultLayer.pipe(
      Layer.provide(Permission.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provide(FSUtil.defaultLayer),
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      Banyan.codegraphAnalyzerDefaultLayer,
      Banyan.searchDefaultLayer,
      Banyan.structuralQueriesDefaultLayer,
      Banyan.gitDefaultLayer,
      Banyan.systemMonitorDefaultLayer,
    ).pipe(
      Layer.provide(AppProcess.defaultLayer as Layer.Layer<unknown, unknown, never>),
      Layer.provide(
        CrossSpawnSpawner.defaultLayer as Layer.Layer<unknown, unknown, never>,
      ),
      Layer.provide(Banyan.codegraphRepoDefaultLayer),
      Layer.provide(Banyan.banyanConfigServiceDefaultLayer),
      Layer.provide(Database.defaultLayer),
    ) as unknown as Layer.Layer<never, never, never>,
  ),
  Layer.provideMerge(
    AiSdkTransportModule.layer as unknown as Layer.Layer<never, never, never>,
  ),
  Layer.provideMerge(
    PermissionBridge.layer
      .pipe(Layer.provide(Permission.defaultLayer)) as unknown as Layer.Layer<never, never, never>,
  ),
)

const rt = ManagedRuntime.make(AppLayer, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">

/** Services provided by AppRuntime — i.e. what an Effect run via AppRuntime.runPromise can yield. */
export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof rt>
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

export const AppRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return rt.runFork(
      Effect.gen(function* () {
        yield* Effect.forkDetach(wrap(effect))
      }) as never,
    )
  },
  runCallback(effect) {
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}

AppRuntime.runFork(applyCodegraphBuildBridge as never)
AppRuntime.runFork(applyFilesystemBridge as never)
AppRuntime.runFork(applySystemMonitorBridge as never)

/**
 * Assert the canonical tool pipeline is consistent: every registered tool
 * materializes when the catalog is required. Run once per opencode process at
 * startup; logs and dies on drift so a misconfiguration surfaces immediately
 * rather than at first tool call.
 */
AppRuntime.runFork(
  Effect.gen(function* () {
    const catalogOption = yield* Effect.serviceOption(ToolCatalog.Service)
    if (catalogOption._tag === "None") return
    const catalog = catalogOption.value
    const registered = (yield* catalog.list()).size
    const materialized = (yield* catalog.materialize()).definitions.length
    const drift = registered - materialized
    yield* Effect.logInfo("─".repeat(40))
    yield* Effect.logInfo("Building Tool Catalog...")
    yield* Effect.logInfo(`  registered:  ${registered}`)
    yield* Effect.logInfo(`  materialized: ${materialized}`)
    yield* Effect.logInfo(`  visible:     ${materialized}`)
    if (drift !== 0) {
      yield* Effect.die(
        new Error(
          `Tool catalog drift: ${registered} registered but ${materialized} materialized. ` +
            `The canonical ToolCatalog pipeline is broken; refusing to start the LLM session.`,
        ),
      )
    }
    yield* Effect.logInfo("─".repeat(40))
  }) as never,
)

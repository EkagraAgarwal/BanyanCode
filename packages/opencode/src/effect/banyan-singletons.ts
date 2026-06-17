export * as BanyanSingletons from "./banyan-singletons"

import { Layer } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { EventV2Bridge } from "@/event-v2-bridge"
import { codegraphBuildBridgeLayer } from "./banyancode-codegraph-bridge"
import { systemMonitorBridgeLayer } from "./banyancode-system-bridge"

/**
 * Shared BanyanCode process singletons — one SubagentBus, CodegraphRepo,
 * EmbeddingProvider, etc.
 *
 * All Banyan `defaultLayer`s are now self-contained: they provide their own
 * upstream deps (Database, FSUtil, HttpClient, EventV2, AppProcess, etc.)
 * so `Layer.mergeAll` resolves everything without cross-layer R hacks.
 * The shared `memoMap` in ManagedRuntime/toWebHandler keeps these as
 * process-level singletons.
 */
export const layer = Layer.mergeAll(
  // Config
  Banyan.banyanConfigServiceDefaultLayer,
  // Repos
  Banyan.codegraphRepoDefaultLayer,
  Banyan.subagentMessagesRepoDefaultLayer,
  Banyan.subagentPlansRepoDefaultLayer,
  Banyan.memoryRepoDefaultLayer,
  // Bus
  Banyan.subagentBusDefaultLayer,
  // Providers & indexers
  Banyan.embeddingProviderDefaultLayer,
  Banyan.codegraphIndexerDefaultLayer,
  Banyan.codegraphEmbedderDefaultLayer,
  // Build service (provides indexer + embedder + provider + repo)
  Banyan.codegraphBuildServiceDefaultLayer,
  // Mesh & consumer
  Banyan.meshCoordinatorDefaultLayer,
  Banyan.subagentConsumerDefaultLayer,
  // System monitor
  Banyan.systemMonitorDefaultLayer,
  // Bridges — use serviceOption so they work even when BanyanCode is disabled
  codegraphBuildBridgeLayer.pipe(
    Layer.provide(Banyan.codegraphBuildServiceDefaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
  systemMonitorBridgeLayer.pipe(
    Layer.provide(Banyan.systemMonitorDefaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
)

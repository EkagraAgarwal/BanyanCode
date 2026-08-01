export * as BanyanTools from "./tools-layer"

import { Layer } from "effect"
import { BanyanToolsManifest } from "./banyan-tools-manifest"
import { RepositoryWave2 } from "../tool/repository-wave2"
import { defaultLayer as memoryRepoLayer } from "./memory-repo"
import { defaultLayer as memoryServiceLayer } from "./memory-service"
import { defaultLayer as subagentBusLayer } from "./subagent-bus"
import { defaultLayer as codegraphRepoLayer } from "./codegraph-repo"
import { defaultLayer as codegraphIndexerLayer } from "./codegraph-indexer"
import { defaultLayer as codegraphAnalyzerLayer } from "./codegraph-analyzer"
import { defaultLayer as editPlannerLayer } from "./edit-planner"
import { defaultLayer as systemMonitorLayer } from "./system-monitor"
import { defaultLayer as subagentPlansRepoLayer } from "./subagent-plans-repo"
import { defaultLayer as meshCoordinatorLayer } from "./mesh-coordinator"

export const locationLayer = BanyanToolsManifest.banyanToolLayer().pipe(
  Layer.provide(subagentBusLayer),
  Layer.provide(memoryRepoLayer),
  Layer.provide(memoryServiceLayer),
  Layer.provide(codegraphRepoLayer),
  Layer.provide(codegraphIndexerLayer),
  Layer.provide(codegraphAnalyzerLayer),
  Layer.provide(editPlannerLayer),
  Layer.provide(systemMonitorLayer),
  Layer.provide(subagentPlansRepoLayer),
  Layer.provide(meshCoordinatorLayer),
)

export * as BanyanTools from "./tools-layer"

import { Layer } from "effect"
import { CodegraphTools } from "../tool/codegraph"
import { CodegraphStatusTools } from "../tool/codegraph-status"
import { CodeEmbedTools } from "../tool/code-embed"
import { MeshControlTool } from "../tool/mesh-control"
import { MemoryTools } from "../tool/memory"
import { SharedMemoryTool } from "../tool/shared-memory"
import { SubagentMessageTool } from "../tool/subagent-message"
import { SystemStatusTool } from "../tool/system-status"
import { defaultLayer as memoryRepoLayer } from "./memory-repo"
import { defaultLayer as subagentBusLayer } from "./subagent-bus"
import { defaultLayer as embeddingProviderLayer } from "./embedding-provider"
import { defaultLayer as codegraphRepoLayer } from "./codegraph-repo"
import { defaultLayer as codegraphIndexerLayer } from "./codegraph-indexer"
import { defaultLayer as codegraphAnalyzerLayer } from "./codegraph-analyzer"
import { defaultLayer as codegraphEmbedderLayer } from "./codegraph-embedder"
import { defaultLayer as systemMonitorLayer } from "./system-monitor"
import { defaultLayer as subagentPlansRepoLayer } from "./subagent-plans-repo"
import { defaultLayer as meshCoordinatorLayer } from "./mesh-coordinator"

export const locationLayer = Layer.mergeAll(
  SharedMemoryTool.locationLayer,
  SubagentMessageTool.layer,
  MeshControlTool.locationLayer,
  MemoryTools.locationLayer,
  CodegraphTools.locationLayer,
  CodegraphStatusTools.locationLayer,
  CodeEmbedTools.locationLayer,
  SystemStatusTool.layer,
).pipe(
  Layer.provide(subagentBusLayer),
  Layer.provide(memoryRepoLayer),
  Layer.provide(embeddingProviderLayer),
  Layer.provide(codegraphRepoLayer),
  Layer.provide(codegraphIndexerLayer),
  Layer.provide(codegraphAnalyzerLayer),
  Layer.provide(codegraphEmbedderLayer),
  Layer.provide(systemMonitorLayer),
  Layer.provide(subagentPlansRepoLayer),
  Layer.provide(meshCoordinatorLayer),
)

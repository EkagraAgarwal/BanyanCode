export * as BanyanTools from "./tools-layer"

import { Layer } from "effect"
import { CodegraphTools } from "../tool/codegraph"
import { CodeFindTool } from "../tool/code-find"
import { CodeEmbedTools } from "../tool/code-embed"
import { EditPlanTool } from "../tool/edit-plan"
import { MeshControlTool } from "../tool/mesh-control"
import { MeshSubscribeTool } from "../tool/mesh-subscribe"
import { MemoryTools } from "../tool/memory"
import { SharedMemoryTool } from "../tool/shared-memory"
import { SubagentMessageTool } from "../tool/subagent-message"
import { SystemStatusTool } from "../tool/system-status"
import { WebSearchFreeTool } from "../tool/websearch-free"
import { defaultLayer as memoryRepoLayer } from "./memory-repo"
import { defaultLayer as subagentBusLayer } from "./subagent-bus"
import { defaultLayer as embeddingProviderLayer } from "./embedding-provider"
import { defaultLayer as codegraphRepoLayer } from "./codegraph-repo"
import { defaultLayer as codegraphIndexerLayer } from "./codegraph-indexer"
import { defaultLayer as codegraphAnalyzerLayer } from "./codegraph-analyzer"
import { defaultLayer as codegraphEmbedderLayer } from "./codegraph-embedder"
import { defaultLayer as editPlannerLayer } from "./edit-planner"
import { defaultLayer as systemMonitorLayer } from "./system-monitor"
import { defaultLayer as subagentPlansRepoLayer } from "./subagent-plans-repo"
import { defaultLayer as meshCoordinatorLayer } from "./mesh-coordinator"

export const locationLayer = Layer.mergeAll(
  SharedMemoryTool.layer,
  SubagentMessageTool.layer,
  MeshControlTool.locationLayer,
  MeshSubscribeTool.locationLayer,
  MemoryTools.locationLayer,
  CodegraphTools.locationLayer,
  CodeFindTool.locationLayer,
  CodeEmbedTools.locationLayer,
  EditPlanTool.locationLayer,
  SystemStatusTool.layer,
  WebSearchFreeTool.layer,
).pipe(
  Layer.provide(subagentBusLayer),
  Layer.provide(memoryRepoLayer),
  Layer.provide(embeddingProviderLayer),
  Layer.provide(codegraphRepoLayer),
  Layer.provide(codegraphIndexerLayer),
  Layer.provide(codegraphAnalyzerLayer),
  Layer.provide(codegraphEmbedderLayer),
  Layer.provide(editPlannerLayer),
  Layer.provide(systemMonitorLayer),
  Layer.provide(subagentPlansRepoLayer),
  Layer.provide(meshCoordinatorLayer),
)

import { Layer } from "effect"
import { BlastRadiusTool } from "../tool/blast-radius"
import { CodeFindTool } from "../tool/code-find"
import { CodegraphSearchTool } from "../tool/codegraph-search-tool"
import { CodegraphTools } from "../tool/codegraph"
import { EditPlanTool } from "../tool/edit-plan"
import { MemoryCandidateTool } from "../tool/memory-candidate"
import { MemoryTools } from "../tool/memory"
import { MeshControlTool } from "../tool/mesh-control"
import { MeshSubscribeTool } from "../tool/mesh-subscribe"
import { PreflightTool } from "../tool/preflight"
import { RepositoryWave2 } from "../tool/repository-wave2"
import { SafeRenameTool } from "../tool/safe-rename"
import { SharedMemoryTool } from "../tool/shared-memory"
import { StructuralQueriesTool } from "../tool/structural-queries-tool"
import { SubagentMessageTool } from "../tool/subagent-message"
import { SystemStatusTool } from "../tool/system-status"
import { WebSearchFreeTool } from "../tool/websearch-free"

export const BANYAN_PUBLIC_TOOL_IDS = [
  "codegraph_build", "codegraph_remove", "code_find",
  "repository_query", "repository_explain", "repository_trace", "repository_tests",
  "blast_radius", "preflight", "safe_rename", "edit_plan", "websearch_free",
  "memory_store", "memory_recall", "memory_list", "memory_search", "memory_forget", "memory_candidate_emit",
  "shared_memory", "mesh_control", "mesh_subscribe", "subagent_message", "system_status",
] as const

export const BANYAN_INTERNAL_TOOL_IDS = [
  "codegraph_query", "codegraph_search", "codegraph_callers", "codegraph_dependents", "codegraph_impact",
  "codegraph_find_implementations", "codegraph_find_overrides", "codegraph_find_recursive", "codegraph_find_async", "codegraph_find_http_routes",
  "repository_impact", "repository_symbols", "repository_relationships", "repository_ownership",
] as const

export const banyanToolLayer = () => Layer.mergeAll(
  CodegraphTools.locationLayer, CodeFindTool.locationLayer, CodegraphSearchTool.locationLayer,
  RepositoryWave2.locationLayer, StructuralQueriesTool.locationLayer, EditPlanTool.locationLayer,
  PreflightTool.locationLayer, BlastRadiusTool.locationLayer, SafeRenameTool.locationLayer,
  WebSearchFreeTool.layer, MemoryTools.locationLayer, MemoryCandidateTool.layer,
  SharedMemoryTool.layer, MeshControlTool.locationLayer, MeshSubscribeTool.locationLayer,
  SubagentMessageTool.layer, SystemStatusTool.layer,
)

export * as BanyanToolsManifest from "./banyan-tools-manifest"

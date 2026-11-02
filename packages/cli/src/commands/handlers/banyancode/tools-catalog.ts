/**
 * The BanyanCode tool surface of the v2 plugin, mirrored for `banyancode tools`.
 *
 * v2 has no `ToolCatalog` service and no tool-listing RPC (the host exposes
 * agents, not tools), so the CLI cannot ask the server what it registered. This
 * list mirrors the plugin's registrations at the time of writing:
 *
 *   - codegraph  `src/codegraph/index.ts` TOOL_IDS + structural queries
 *   - intel      `src/intel/tools.ts` NAMES
 *   - mesh       `src/mesh/tools.ts`
 *   - verify     `src/verify/tools.ts` NAME_*
 *   - system     `src/system/tools.ts` TOOL_IDS
 *   - agents     `src/agents/goal-tool.ts` GOAL_TOOL
 *   - host       `packages/core/src/tool/plugin/*` primitive tools
 *
 * Categories and the classification order are v1's (`cli/cmd/tools.ts`) so
 * `--category` keeps working for scripts.
 */

export type Category = "Primitive" | "Repository" | "Codegraph" | "Search" | "Mesh" | "Edit" | "MCP"

const PRIMITIVES = new Set([
  // v2 host tool ids
  "read",
  "write",
  "edit",
  "patch",
  "glob",
  "grep",
  "shell",
  "webfetch",
  "websearch",
  "subagent",
  "todowrite",
  "skill",
  "question",
  "models",
  "artifact_create",
  "artifact_read",
  "artifact_update",
  "artifact_delete",
  "schedule",
  "schedule_create",
  "schedule_list",
  "schedule_pause",
  "schedule_resume",
  "schedule_delete",
  "list_mcp_resources",
  "read_mcp_resource",
  "experimental_image_generate",
  // v1 aliases kept so a v1 script's `--category Primitive` still matches
  "bash",
  "fetch",
  "task",
  "todo",
  "invalid",
  "lsp",
  "plan",
])

/** v1 `classify`, extended with v2's primitive tool ids. */
export const classify = (name: string): Category => {
  if (PRIMITIVES.has(name)) return "Primitive"
  if (name.startsWith("repository_")) return "Repository"
  if (name.startsWith("codegraph_")) return "Codegraph"
  if (name.startsWith("code_find") || name === "search" || name === "websearch_free") return "Search"
  if (name.startsWith("mesh_")) return "Mesh"
  if (name === "edit_plan") return "Edit"
  return "MCP"
}

export const ORDER: ReadonlyArray<Category> = [
  "Primitive",
  "Repository",
  "Codegraph",
  "Search",
  "Mesh",
  "Edit",
  "MCP",
]

export const CATALOG: ReadonlyArray<string> = [
  // host primitives
  "read",
  "write",
  "edit",
  "patch",
  "glob",
  "grep",
  "shell",
  "webfetch",
  "websearch",
  "subagent",
  "todowrite",
  "skill",
  "question",
  "models",
  "artifact_create",
  "artifact_read",
  "artifact_update",
  "artifact_delete",
  "schedule_create",
  "schedule_list",
  "schedule_pause",
  "schedule_resume",
  "schedule_delete",
  "list_mcp_resources",
  "read_mcp_resource",
  "experimental_image_generate",
  // repository intelligence
  "repository_query",
  "repository_explain",
  "repository_impact",
  "repository_trace",
  "repository_tests",
  "repository_symbols",
  "repository_relationships",
  "repository_ownership",
  "preflight",
  "blast_radius",
  "safe_rename",
  "edit_plan",
  // codegraph
  "codegraph_build",
  "codegraph_remove",
  "codegraph_query",
  "codegraph_impact",
  "codegraph_dependents",
  "codegraph_callers",
  "codegraph_staleness",
  "codegraph_search",
  "code_find",
  "codegraph_find_implementations",
  "codegraph_find_overrides",
  "codegraph_find_recursive",
  "codegraph_find_async",
  "codegraph_find_http_routes",
  // mesh
  "mesh_control",
  "mesh_subscribe",
  "mesh_status",
  "subagent_message",
  // verification
  "banyan_test",
  "banyan_typecheck",
  "banyan_lint",
  "banyan_compile",
  // system + goal
  "system_status",
  "systeminfo",
  "banyan_tool_search",
  "goal",
]

export const groupCatalog = (names: ReadonlyArray<string> = CATALOG) => {
  const grouped = new Map<Category, string[]>()
  for (const name of [...names].sort()) {
    const category = classify(name)
    const entries = grouped.get(category) ?? []
    entries.push(name)
    grouped.set(category, entries)
  }
  return grouped
}

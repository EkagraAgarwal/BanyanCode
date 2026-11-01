import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import type { Interface as StorageInterface } from "../storage/service.js"
import type { SystemMonitor, SystemStatus } from "./monitor.js"
import { formatBytesGb, formatBytesMb } from "./monitor.js"

/**
 * v1 tool ports: `system_status`, `systeminfo` and `banyan_tool_search`.
 * IDs, descriptions and input parameters are verbatim from
 * `packages/core/src/tool/system-status.ts`,
 * `packages/opencode/src/tool/systeminfo.txt` and
 * `packages/core/src/tool/tool-search.ts`.
 */

export const NAME_SYSTEM_STATUS = "system_status"
export const NAME_SYSTEMINFO = "systeminfo"
export const NAME_TOOL_SEARCH = "banyan_tool_search"

/** Strict tool-schema validators reject `Schema.Struct({})`; `Record` projects to `{type:"object"}`. */
export const InputRecord = Schema.Record(Schema.String, Schema.Unknown)

export const SystemStatusOutput = Schema.Struct({
  cpuPercent: Schema.optional(Schema.Number),
  memoryUsedBytes: Schema.Number,
  memoryTotalBytes: Schema.Number,
  gpuPercent: Schema.optional(Schema.Number),
  vramUsedBytes: Schema.optional(Schema.Number),
  gpuTotalBytes: Schema.optional(Schema.Number),
  platform: Schema.Literals(["windows", "linux", "darwin"]),
}).annotate({ identifier: "Banyan.SystemStatusToolOutput" })

export const renderSystemStatus = (output: typeof SystemStatusOutput.Type): string => {
  const cpu =
    output.cpuPercent !== undefined ? `CPU: ${output.cpuPercent.toFixed(1)}%` : "CPU: (unavailable, sampling)"
  return `${cpu}, Memory: ${formatBytesMb(output.memoryUsedBytes)}MB / ${formatBytesMb(output.memoryTotalBytes)}MB, Platform: ${output.platform}`
}

export const renderSystemInfo = (output: SystemStatus): string => {
  const cpu =
    output.cpuPercent !== undefined ? `CPU: ${output.cpuPercent.toFixed(1)}%` : "CPU: (unavailable, sampling)"
  const gpu =
    output.gpuPercent !== undefined && output.vramUsedBytes !== undefined && output.gpuTotalBytes !== undefined
      ? `GPU: ${output.gpuPercent}% | VRAM: ${formatBytesGb(output.vramUsedBytes)}/${formatBytesGb(output.gpuTotalBytes)} GB`
      : "GPU: N/A"
  return [
    `Platform: ${output.platform}`,
    cpu,
    `Memory: ${formatBytesGb(output.memoryUsedBytes)} / ${formatBytesGb(output.memoryTotalBytes)} GB`,
    gpu,
  ].join("\n")
}

const toolResult = (output: typeof SystemStatusOutput.Type): Tool.Result<typeof SystemStatusOutput> => ({
  output,
  content: renderSystemStatus(output),
})

const stripDisk = (status: SystemStatus): typeof SystemStatusOutput.Type => ({
  ...(status.cpuPercent === undefined ? {} : { cpuPercent: status.cpuPercent }),
  memoryUsedBytes: status.memoryUsedBytes,
  memoryTotalBytes: status.memoryTotalBytes,
  ...(status.gpuPercent === undefined ? {} : { gpuPercent: status.gpuPercent }),
  ...(status.vramUsedBytes === undefined ? {} : { vramUsedBytes: status.vramUsedBytes }),
  ...(status.gpuTotalBytes === undefined ? {} : { gpuTotalBytes: status.gpuTotalBytes }),
  platform: status.platform,
})

export const makeSystemStatusTool = (monitor: SystemMonitor): Tool.Info<typeof InputRecord, typeof SystemStatusOutput> => ({
  name: NAME_SYSTEM_STATUS,
  description:
    "Get current system health: CPU usage, memory used/total, GPU usage (if available), and platform. Call proactively before resource-intensive operations like code indexing, embedding, or LLM queries to make informed decisions.",
  input: InputRecord,
  output: SystemStatusOutput,
  options: { permission: NAME_SYSTEM_STATUS },
  execute: () =>
    Effect.gen(function* () {
      const status = yield* Effect.promise(() => monitor.status())
      return toolResult(stripDisk(status))
    }),
})

export const SystemInfoOutput = Schema.Struct({
  cpuPercent: Schema.optional(Schema.Number),
  memoryUsedBytes: Schema.Number,
  memoryTotalBytes: Schema.Number,
  gpuPercent: Schema.optional(Schema.Number),
  vramUsedBytes: Schema.optional(Schema.Number),
  gpuTotalBytes: Schema.optional(Schema.Number),
  diskUsedBytes: Schema.optional(Schema.Number),
  diskTotalBytes: Schema.optional(Schema.Number),
  platform: Schema.Literals(["windows", "linux", "darwin"]),
}).annotate({ identifier: "Banyan.SystemInfoToolOutput" })

export const makeSystemInfoTool = (monitor: SystemMonitor): Tool.Info<typeof InputRecord, typeof SystemInfoOutput> => ({
  name: NAME_SYSTEMINFO,
  description: [
    "# systeminfo",
    "",
    "Get current system status for the local machine.",
    "",
    "Returns:",
    "- CPU usage percentage",
    "- Memory used / total (with human-readable sizes)",
    "- GPU usage percentage (if available)",
    "- VRAM used / total (if available)",
    "- Platform (windows/linux/darwin)",
    "",
    "Use this tool when:",
    "- You need to understand resource constraints before running heavy operations",
    "- The user asks about system performance or available resources",
    "- You need to make decisions about parallelism based on system capacity",
    "",
    "Examples:",
    '- "Check if we have enough memory to build this project"',
    '- "What\'s the current CPU usage?"',
    '- "Are we running on GPU?',
  ].join("\n"),
  input: InputRecord,
  output: SystemInfoOutput,
  options: { permission: NAME_SYSTEMINFO },
  execute: () =>
    Effect.gen(function* () {
      const status = yield* Effect.promise(() => monitor.status())
      return { output: status, content: renderSystemInfo(status) }
    }),
})

// ── banyan_tool_search ─────────────────────────────────────────────────────

const QueryField = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9 _./-]*$/))

export const ToolSearchInput = Schema.Struct({
  query: QueryField.annotate({
    description:
      "Free-text query that matches against tool id, description, and tier. Minimum length: 1; sanitize via the pattern. Whitespace is allowed.",
  }),
  tier: Schema.optional(
    Schema.Literals(["hot", "warm", "cold", "all"]).annotate({
      description:
        "Restrict the search to a single tier or include all tiers (default `all`). Use `cold` to discover advanced/internal tools; use `hot` to refresh the registry view of always-mounted tools.",
    }),
  ),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum number of results to return. Defaults to 12. Allowed range: 1-50.",
  }),
}).annotate({
  description:
    "Search the BanyanCode adapted tool catalog (hot / warm / cold tiers). " +
    "Returns matching tool descriptions so the model can discover cold tools " +
    "without inflating the always-mounted system prompt.",
})

const AdaptedToolSchema = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  tier: Schema.Literals(["hot", "warm", "cold"]),
  schema: Schema.Unknown,
  examples: Schema.optional(Schema.Array(Schema.String)),
})

const SearchHitSchema = Schema.Struct({
  tool: AdaptedToolSchema,
  relevance: Schema.Number,
})

export const ToolSearchOutput = Schema.Struct({
  query: Schema.String,
  tier: Schema.Literals(["hot", "warm", "cold", "all"]),
  total: Schema.Int,
  hits: Schema.Array(SearchHitSchema),
  _diagnostic: Schema.optional(Schema.Literals(["empty-query", "no-matches"])),
})

const SCORE_EXACT = 4
const SCORE_PREFIX = 3
const SCORE_INCLUDES = 2
const SCORE_NONE = 1

export const scoreMatch = (needle: string, haystack: string): number => {
  const value = haystack.toLowerCase()
  if (value === needle) return SCORE_EXACT
  if (value.startsWith(needle)) return SCORE_PREFIX
  if (value.includes(needle)) return SCORE_INCLUDES
  return SCORE_NONE
}

/** v2 has no tool visibility tiers; these are the tools v1 marked internal. */
const INTERNAL_TOOL_PREFIXES = ["codegraph_", "repository_", "banyan_typecheck", "banyan_lint"]

export const tierFor = (id: string, recent: ReadonlySet<string>): "hot" | "warm" | "cold" => {
  if (recent.has(id)) return "hot"
  if (INTERNAL_TOOL_PREFIXES.some((prefix) => id.startsWith(prefix))) return "cold"
  return "warm"
}

const schemaOf = (input: unknown): unknown => {
  if (!Schema.isSchema(input)) return input ?? {}
  try {
    return Schema.toJsonSchemaDocument(input, { onExcessProperty: "error" })
  } catch {
    return {}
  }
}

export const renderToolSearch = (output: typeof ToolSearchOutput.Type): string => {
  const header = `query="${output.query}" tier=${output.tier} total=${output.total}${output._diagnostic ? ` diagnostic=${output._diagnostic}` : ""}`
  if (output.hits.length === 0) return `${header}\n\nNo matching tools.`
  const lines = output.hits.map((hit) => {
    const description = hit.tool.description.replace(/\s+/g, " ").trim()
    return `  ${hit.tool.id} (${hit.tool.tier}) rel=${hit.relevance.toFixed(2)}\n    ${description}`
  })
  return `${header}\n\n${lines.join("\n")}`
}

export interface ToolSearchDeps {
  readonly ctx: Context
  readonly storage: StorageInterface
  readonly now?: () => number
}

const recentTools = (storage: StorageInterface, now: number): Effect.Effect<ReadonlySet<string>> =>
  storage
    .query<{ tool_id: string }>(
      "SELECT tool_id FROM codegraph_tool_usage WHERE last_used_at >= ?",
      [Math.floor(now / 1000) - 86_400],
    )
    .pipe(
      Effect.map((rows) => new Set(rows.map((row) => row.tool_id))),
      Effect.catchCause(() => Effect.succeed(new Set<string>())),
    )

export const makeToolSearchTool = (
  deps: ToolSearchDeps,
): Tool.Info<typeof ToolSearchInput, typeof ToolSearchOutput> => ({
  name: NAME_TOOL_SEARCH,
  description:
    "Use when:\n" +
    "  the model needs to discover a tool that is NOT mounted in the system " +
    "  prompt. Cold (advanced/internal) tools are not inlined — call " +
    "  banyan_tool_search to surface them by query.\n" +
    "Examples\n" +
    '  - "Find a tool to test the current build"\n' +
    '  - "Search for tools related to verification"\n' +
    '  - "List all hot tools" (tier=\'hot\')\n' +
    "Returns\n" +
    "  { hits: [{ tool, relevance }] } — every hit includes id, " +
    "  description, tier, and the registry's input schema.\n" +
    "Avoid when\n" +
    "  the tool is already mounted — check the tool list in the system " +
    "  prompt first; this tool duplicates that view at higher cost.\n" +
    "Routing tier note: the searched catalog covers all three tiers " +
    "  (hot / warm / cold). The default tier='all' includes hot tools " +
    "  too, so the model can re-read the current schema after prompts " +
    "  drift.",
  input: ToolSearchInput,
  output: ToolSearchOutput,
  options: { permission: NAME_TOOL_SEARCH },
  execute: (input, context) =>
    Effect.gen(function* () {
      const query = input.query.trim()
      if (query.length === 0) {
        const output = { query, tier: input.tier ?? "all", total: 0, hits: [], _diagnostic: "empty-query" as const }
        return { output, content: renderToolSearch(output) }
      }
      yield* deps.ctx.permission.assert({
        action: NAME_TOOL_SEARCH,
        resources: [query],
        save: ["*"],
        metadata: { query, tier: input.tier ?? "all" },
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
      const registered = yield* deps.ctx.tool.list()
      const recent = yield* recentTools(deps.storage, (deps.now ?? Date.now)())
      const needle = query.toLowerCase()
      const limit = input.limit ?? 12
      const tierFilter = input.tier ?? "all"
      const candidates = registered.map((tool) => {
        const tier = tierFor(tool.id, recent)
        return {
          id: tool.id,
          description: tool.description,
          tier,
          schema: schemaOf(tool.input),
        }
      })
      const filtered = tierFilter === "all" ? candidates : candidates.filter((tool) => tool.tier === tierFilter)
      const hits = filtered
        .map((tool) => {
          const idLower = tool.id.toLowerCase()
          const descLower = tool.description.toLowerCase()
          const idScore = scoreMatch(needle, idLower) * 3
          const descScore = scoreMatch(needle, descLower)
          const tierScore = tool.tier === "hot" ? 1.5 : tool.tier === "warm" ? 1.0 : 0.5
          return {
            tool,
            relevance: (idScore + descScore) * tierScore,
            match: idLower.includes(needle) || descLower.includes(needle),
          }
        })
        .filter((hit) => hit.match)
        .map(({ match: _match, ...hit }) => hit)
        .sort((a, b) => b.relevance - a.relevance || a.tool.id.localeCompare(b.tool.id))
        .slice(0, Math.max(1, Math.min(limit, 50)))
      const output = {
        query,
        tier: tierFilter,
        total: hits.length,
        hits,
        ...(hits.length === 0 ? { _diagnostic: "no-matches" as const } : {}),
      }
      return { output, content: renderToolSearch(output) }
    }),
})

export const buildSystemTools = (deps: {
  readonly ctx: Context
  readonly monitor: SystemMonitor
  readonly storage: StorageInterface
  readonly now?: () => number
}): Tool.Info[] => [
  makeSystemStatusTool(deps.monitor),
  makeSystemInfoTool(deps.monitor),
  makeToolSearchTool({ ctx: deps.ctx, storage: deps.storage, ...(deps.now === undefined ? {} : { now: deps.now }) }),
]

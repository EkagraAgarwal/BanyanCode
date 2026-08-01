export * as ToolSearchTool from "./tool-search"

import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { traced } from "../observability/trace"
import { PermissionV2 } from "../permission"
import { type Interface as AdaptedCatalogInterface } from "../banyancode/adapted-catalog"
import { Service as ToolRegistryService, type Interface as ToolRegistryInterface } from "../tool/registry"
import { Service as AgentV2Service, Info as AgentV2Info, ID as AgentV2ID } from "../agent"
import { ModelV2 } from "../model"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { optionalNumber } from "./tool-schema"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "banyan_tool_search"

const QueryField = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9 _./-]*$/))

export const Input = Schema.Struct({
  query: QueryField.annotate({
    description: "Free-text query that matches against tool id, description, and tier. Minimum length: 1; sanitize via the pattern. Whitespace is allowed.",
  }),
  tier: Schema.optional(Schema.Literals(["hot", "warm", "cold", "all"]).annotate({
    description:
      "Restrict the search to a single tier or include all tiers (default " +
      "`all`). Use `cold` to discover advanced/internal tools; use `hot` to " +
      "refresh the registry view of always-mounted tools.",
  })),
  limit: optionalNumber.annotate({
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

export const Output = Schema.Struct({
  query: Schema.String,
  tier: Schema.Literals(["hot", "warm", "cold", "all"]),
  total: Schema.Int,
  hits: Schema.Array(SearchHitSchema),
  _diagnostic: Schema.optional(Schema.Literals(["empty-query", "no-matches"])),
})

const scoreMatch = (needle: string, haystack: string) => {
  const value = haystack.toLowerCase()
  if (value === needle) return 4
  if (value.startsWith(needle)) return 3
  if (value.includes(needle)) return 2
  return 1
}

const renderOutput = (output: Schema.Schema.Type<typeof Output>): string => {
  const header = `query="${output.query}" tier=${output.tier} total=${output.total}${output._diagnostic ? ` diagnostic=${output._diagnostic}` : ""}`
  if (output.hits.length === 0) {
    return `${header}\n\nNo matching tools.`
  }
  const lines = output.hits.map((hit) => {
    const description = hit.tool.description.replace(/\s+/g, " ").trim()
    return `  ${hit.tool.id} (${hit.tool.tier}) rel=${hit.relevance.toFixed(2)}\n    ${description}`
  })
  return `${header}\n\n${lines.join("\n")}`
}

const emptyAgent = (id: string) => AgentV2Info.empty(AgentV2ID.make(id))
const emptyModel = () => ModelV2.Info.empty("stub" as never, "stub" as never)
const toolCapableModel = () => {
  const base = emptyModel()
  return new ModelV2.Info({
    ...base,
    capabilities: { tools: true, input: [], output: [] },
  })
}

export const makeToolSearchTool = (deps: {
  readonly permission: PermissionV2.Interface
  readonly catalog: AdaptedCatalogInterface
  readonly registry: ToolRegistryInterface
  readonly resolveAgent: (id: string) => Effect.Effect<AgentV2Info | undefined, never, never>
}) =>
  Tool.make({
    description:
      "Use when:\n" +
      "  the model needs to discover a tool that is NOT mounted in the system " +
      "  prompt. Cold (advanced/internal) tools are not inlined — call " +
      "  banyan_tool_search to surface them by query.\n" +
      "Examples\n" +
      "  - \"Find a tool to test the current build\"\n" +
      "  - \"Search for tools related to verification\"\n" +
      "  - \"List all hot tools\" (tier='hot')\n" +
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
    contract: { visibility: "public" },
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [{ type: "text", text: renderOutput(output) }],
    execute: (input, context) =>
      traced(
        process.cwd(),
        context.sessionID,
        name,
        input,
        (output) => `query="${input.query}" tier=${output.tier} hits=${output.hits.length} total=${output.total}`,
        Effect.gen(function* () {
          const query = input.query.trim()
          if (query.length === 0) {
            return {
              query,
              tier: input.tier ?? "all",
              total: 0,
              hits: [],
              _diagnostic: "empty-query" as const,
            }
          }
          yield* deps.permission.assert({
            action: name,
            resources: [query],
            save: ["*"],
            metadata: { query, tier: input.tier ?? "all" },
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
          }).pipe(Effect.orDie)

          const agent = (yield* deps.resolveAgent(context.agent)) ?? emptyAgent(context.agent)
          const model = toolCapableModel()
          const materialization = yield* deps.catalog.materialize({
            registry: deps.registry,
            agent,
            model,
          })
          const limit = input.limit ?? 12
          const tierFilter = input.tier ?? "all"
          const filtered = tierFilter === "all" ? materialization : materialization.filter((tool) => tool.tier === tierFilter)
          const needle = query.toLowerCase()
          const ranked = filtered
            .map((tool) => {
              const idLower = tool.id.toLowerCase()
              const descLower = tool.description.toLowerCase()
              const idScore = scoreMatch(needle, idLower) * 3
              const descScore = scoreMatch(needle, descLower)
              const tierScore = tool.tier === "hot" ? 1.5 : tool.tier === "warm" ? 1.0 : 0.5
              const relevance = (idScore + descScore) * tierScore
              const idMatch = idLower.includes(needle)
              const descMatch = descLower.includes(needle)
              return { tool, relevance, idMatch, descMatch }
            })
            .filter((hit) => hit.idMatch || hit.descMatch)
            .map(({ idMatch: _idMatch, descMatch: _descMatch, ...rest }) => rest)
            .sort((a, b) => b.relevance - a.relevance || a.tool.id.localeCompare(b.tool.id))
            .slice(0, Math.max(1, Math.min(limit, 50)))
          return {
            query,
            tier: tierFilter,
            total: ranked.length,
            hits: ranked,
            ...(ranked.length === 0 ? { _diagnostic: "no-matches" as const } : {}),
          }
        }),
      )
  })

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const catalog = yield* Banyan.AdaptedCatalog
    const registry = yield* ToolRegistryService
    const agents = yield* AgentV2Service

    yield* tools.register({
      [name]: makeToolSearchTool({
        permission,
        catalog,
        registry,
        resolveAgent: (id) => agents.resolve(id as never) as Effect.Effect<AgentV2Info | undefined, never, never>,
      }),
    })
  }),
)

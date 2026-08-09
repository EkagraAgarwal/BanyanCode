/**
 * BanyanCode Codegraph System Source.
 *
 * Renders the policy + tool-guide block that is appended to the model-facing
 * system prompt when BanyanCode is enabled. The block has two parts:
 *
 *   1. The `## Codegraph-first search policy (ALWAYS)` section — a static,
 *      model-facing paragraph that tells the LLM to always reach for graph +
 *      repository tools first, and to bootstrap a code graph before any other
 *      action if one does not exist. Always emitted when BanyanCode is enabled
 *      (gated on `process.env.BANYANCODE_ENABLE !== "0"`).
 *   2. The `## BanyanCode tool guide` section — a per-session list of the
 *      LLM-visible BanyanCode tools that have been materialized for the
 *      agent+model pair. Only emitted when the caller supplies a `tools` array.
 *
 * The service is reached both by V1 (delegated from
 * `packages/opencode/src/session/system.ts` via `Effect.serviceOption` or by
 * reading `policyText` directly when the service is not in scope) and by the
 * V2 runtime, which can compose the rendered text directly or register the
 * source through the `register` helper against
 * `SystemContextRegistry.Service`.
 */

import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { SystemContext } from "../system-context"
import { SystemContextRegistry } from "../system-context/registry"
import { BanyanToolsManifest } from "./banyan-tools-manifest"

export interface CodegraphToolDescription {
  readonly id: string
  readonly description: string
}

export interface CodegraphSystemInput {
  readonly location?: Location.Ref
  readonly agent?: AgentV2.Info
  readonly model?: ModelV2.Info
  readonly tools?: ReadonlyArray<CodegraphToolDescription>
  readonly graph?: { readonly state: "ready" | "building" | "missing"; readonly symbols?: number }
}

export interface Interface {
  readonly load: (input?: CodegraphSystemInput) => Effect.Effect<string, never, never>
  readonly policyText: string
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphSystemSource") {}

export const POLICY_TEXT = [
  "## Codegraph-first search policy (ALWAYS)",
  "",
  "ALWAYS use BanyanCode graph + repository tools first for any code",
  "question in this workspace. Grep / glob / bash and raw file reads are",
  "last resorts, not defaults. The BanyanCode tool guide below lists the",
  "session's Banyan tools by family; full input/output schemas are in the",
  "tool list.",
  "",
  "Session start: if Graph state is ready, call `banyan_repo_map` once,",
  "then `code_find` before touching files.",
  "",
  "Cost: one graph call replaces 3-5 bash grep/read loops; repo tools",
  "return file:line answers you can edit. Hot tools (mounted):",
  "`code_find`, `repository_query`, `blast_radius`, `preflight`; anything",
  "else: `banyan_tool_search`.",
  "",
  "Bootstrap (BEFORE any other action):",
  "1. Graph/repo tools auto-trigger a build ONLY when the graph is missing",
  "   or structurally invalid (no meta row, empty file table, root/schema",
  "   mismatch). Don't run `codegraph_build` on every session — it returns",
  "   `ready` when fresh.",
  "2. To refresh (you made edits, or want to re-index), call",
  "   `codegraph_build` explicitly — manual builds beat waiting for an",
  "   auto-trigger.",
  "3. After the build, use graph tools first: `code_find` (intents:",
  "   definition, callers, dependents, impact, find_file).",
  "4. For semantic/architectural context: `repository_query`,",
  "   `repository_explain`, `repository_trace`, `repository_tests`.",
  "5. Before any non-trivial edit, run `blast_radius` (summary) or",
  "   `preflight` (callers, tests, docs, configs, event bridges, HTTP",
  "   routes).",
  "6. After edits, run `edit_plan(phase=\"after\")` to re-verify blast radius.",
  "",
  "Tool routing ladder — pick the FIRST tool that matches the question:",
  "- 'Where is X declared?' → `code_find(intent='definition')`",
  "- 'Who calls X? / what depends on X?' → `code_find(intent='callers' | 'dependents')`",
  "- 'Find the file for X' → `code_find(intent='find_file')`",
  "- 'What does this workspace look like?' → `banyan_repo_map` (packages, entry points, per-file symbols)",
  "- 'Architecture / how does X fit in?' → `repository_explain`",
  "- 'What breaks if I edit file F?' → `repository_impact(path=F)`",
  "- 'Follow the call chain from X' → `repository_trace(symbol=X)`",
  "- 'Which tests cover X?' → `repository_tests(symbol=X)`",
  "- 'Find anything about <topic>' → `repository_query(query=<topic>)`",
  "- 'How risky is changing X?' → `blast_radius(target=X)` (counts) or `preflight(target=X)` (full report)",
  "- 'Plan / verify an edit' → `edit_plan(phase='before' | 'after')`",
  "- 'Rename X safely' → `safe_rename(symbol=X)`",
  "",
  "Only fall back to grep / glob / bash when:",
  "- a graph tool reports empty / stale / not-found,",
  "- the user asks for regex or filename-pattern matching,",
  "- you're searching non-code artifacts (configs, JSON, docs, build outputs).",
].join("\n")

// Lookup the public tool ids lazily: reading BanyanToolsManifest.* at module
// load would re-enter the still-initializing manifest (its own module
// imports tool files that import the banyancode barrel, which re-enters
// this namespace). At runtime the manifest is fully loaded.
const getBanyanToolIds = (): ReadonlySet<string> =>
  new Set<string>(BanyanToolsManifest.BANYAN_PUBLIC_TOOL_IDS)

const TOOL_FAMILIES = [
  { title: "Code graph", ids: ["codegraph_build", "codegraph_remove", "code_find"] },
  { title: "Repository intelligence", ids: ["repository_query", "repository_explain", "repository_impact", "repository_trace", "repository_tests"] },
  { title: "Edit decision support", ids: ["blast_radius", "preflight", "safe_rename", "edit_plan"] },
  { title: "External research", ids: ["websearch_free"] },
  { title: "Memory", ids: ["memory_store", "memory_recall", "memory_list", "memory_search", "memory_forget", "memory_candidate_emit"] },
  { title: "Mesh coordination", ids: ["mesh_control", "mesh_subscribe"] },
  { title: "Peer messaging", ids: ["subagent_message"] },
  { title: "Shared memory", ids: ["shared_memory"] },
  { title: "System status", ids: ["system_status"] },
  { title: "Goals", ids: ["goal"] },
  { title: "Repository map", ids: ["banyan_repo_map", "banyan_tool_search"] },
  { title: "Verification", ids: ["banyan_test"] },
] as const

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

// Guide entries render only the first sentence of each tool description —
// the model already receives the full descriptions and schemas in its
// function tool list, so the guide just needs family discoverability.
// Long first sentences are truncated at MAX_DESCRIPTION_CHARS with "…".
const MAX_DESCRIPTION_CHARS = 140

const firstSentence = (description: string): string => {
  const collapsed = description.replace(/\s+/g, " ").trim()
  // Sentence end: a period followed by whitespace + an uppercase letter
  // (or "(" / backtick), so abbreviations like "e.g." are not boundaries.
  const end = collapsed.search(/\.(?=\s+[A-Z(`]|$)/)
  const sentence = end === -1 ? collapsed : collapsed.slice(0, end + 1)
  return sentence.length > MAX_DESCRIPTION_CHARS
    ? `${sentence.slice(0, MAX_DESCRIPTION_CHARS)}…`
    : sentence
}

function renderToolGuide(tools: ReadonlyArray<CodegraphToolDescription>): string {
  const allowed = getBanyanToolIds()
  const visible = tools.filter((tool) => allowed.has(tool.id))
  if (visible.length === 0) return ""
  const byId = new Map<string, CodegraphToolDescription>(visible.map((tool) => [tool.id, tool]))
  const sections: string[] = []
  for (const family of TOOL_FAMILIES) {
    const entries: string[] = []
    for (const id of family.ids) {
      const tool = byId.get(id)
      if (!tool) continue
      entries.push(`- **${tool.id}** — ${firstSentence(tool.description)}`)
    }
    if (entries.length === 0) continue
    sections.push(`### ${family.title}\n\n${entries.join("\n")}`)
  }
  if (sections.length === 0) return ""
  return [
    "## BanyanCode tool guide",
    "",
    "The following Banyan tools are available in this session, grouped by",
    "family. Full input/output schemas are in the tool list.",
    "",
    sections.join("\n\n"),
  ].join("\n")
}

// Phase A: one "Graph state:" line appended to the rendered block so the
// model can tell "graph ready" from "graph absent". `symbols` is the
// indexer's total-file count (codegraph coverage numerator), rendered with
// locale separators when present.
const graphLineFor = (graph: NonNullable<CodegraphSystemInput["graph"]>): string => {
  if (graph.state === "ready") {
    const symbols = graph.symbols === undefined ? "N/A" : graph.symbols.toLocaleString()
    return `Graph state: ready (${symbols} symbols) — use code_find/repository_* now.`
  }
  if (graph.state === "building") {
    return "Graph state: building in background — first graph call will wait for the build."
  }
  return "Graph state: missing — the first graph call will build it."
}

const loadImpl: Interface["load"] = Effect.fn("CodegraphSystemSource.load")(function* (input) {
  const tools = input?.tools ?? []
  const graph = input?.graph
  // Pinned: without tools AND without a graph state, the output is exactly
  // POLICY_TEXT (no trailing join artifacts).
  if (tools.length === 0 && graph === undefined) return POLICY_TEXT
  const guide = renderToolGuide(tools)
  const graphLine = graph === undefined ? "" : graphLineFor(graph)
  return [POLICY_TEXT, guide, graphLine].filter((part) => part.length > 0).join("\n\n")
})

export const layer: Layer.Layer<Service, never, never> = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of({ load: loadImpl, policyText: POLICY_TEXT })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, never> = layer

const sourceKey = SystemContext.Key.make("banyancode/codegraph-policy")
const stringCodec = Schema.toCodecJson(Schema.String)

/**
 * Register the policy-only block as a `SystemContext` source with the given
 * registry. The source is static (the same policy text on every load); V2
 * callers that need the per-session tool guide should compose
 * `Service.load({ ... })` directly into the system prompt rather than going
 * through the registry.
 *
 * Registration is skipped entirely when `process.env.BANYANCODE_ENABLE === "0"`.
 */
export const register = Effect.fn("CodegraphSystemSource.register")(function* (registry: SystemContextRegistry.Interface) {
  if (!banyancodeEnabled()) return
  const source = SystemContext.make<string>({
    key: sourceKey,
    codec: stringCodec,
    load: Effect.succeed(POLICY_TEXT),
    baseline: (current) => current,
    update: (_previous, current) => current,
  })
  const entry: SystemContextRegistry.Entry = {
    key: sourceKey,
    load: Effect.succeed(source),
  }
  yield* registry.register(entry)
})

export * as CodegraphSystemSource from "./codegraph-system-source"

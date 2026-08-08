/**
 * BanyanCode Codegraph System Source.
 *
 * Renders the policy + tool-guide block that is appended to the model-facing
 * system prompt when BanyanCode is enabled. The block has three parts:
 *
 *   1. The `## Codegraph-first search policy (ALWAYS)` section — a static,
 *      model-facing paragraph that tells the LLM to always reach for graph +
 *      repository tools first, and to bootstrap a code graph before any other
 *      action if one does not exist. Always emitted when BanyanCode is enabled
 *      (gated on `process.env.BANYANCODE_ENABLE !== "0"`).
 *   2. The `## Graph-first routing (ALWAYS)` section — the dynamic graph-state
 *      line plus a short per-task routing rule, rendered right after the
 *      policy and before the tool guide so the model sees current graph state
 *      and the routing rule early. Only emitted when the caller supplies a
 *      `graph` state.
 *   3. The `## BanyanCode tool guide` section — a per-session list of the
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
  "ALWAYS use BanyanCode graph + repository tools first for any code question",
  "in this workspace. Per task, pick the FIRST matching graph/repository tool",
  "before reading or searching source code. A session-start repo map alone",
  "does not satisfy later task-specific lookups — re-query the graph for each",
  "new symbol, file, or call question. Grep / glob / bash and raw file reads",
  "are last resorts, not defaults.",
  "",
  "Exemptions — skip the graph ONLY for:",
  "- regex or filename-pattern matching the user explicitly asked for,",
  "- non-code artifacts (configs, JSON, docs, lockfiles, build outputs).",
  "",
  "Routing ladder — first match wins:",
  "- symbol/file lookup → `code_find` (definition, callers, dependents, impact, find_file)",
  "- workspace outline → `banyan_repo_map`",
  "- architecture / call chain / tests / semantic search → `repository_query`, `repository_explain`, `repository_trace`, `repository_tests`",
  "- edit risk / verification → `blast_radius`, `preflight`, `edit_plan`",
  "- rename → `safe_rename`",
  "- build/refresh → `codegraph_build` (auto-triggers only when the graph is missing",
  "  or structurally invalid; manual builds are the preferred refresh path)",
  "",
  "Fall back to grep/glob/bash only after YOU called a graph/repository tool",
  "and it returned not-found/empty/stale/failed, or an exemption applies.",
  "",
  "The `Graph state` line below says whether the index is built yet: when it",
  "reads `missing`, run `codegraph_build` once at session start (it returns",
  "ready if the graph already exists) — or the first graph call will build it",
  "lazily.",
  "",
  "## Background subagents (ALWAYS)",
  "",
  "When delegating via the `task` tool, prefer `background: true`. Sync",
  "(foreground) delegation blocks your context and wastes tokens. Sync is",
  "acceptable ONLY for a trivial single-tool-call lookup where waiting is",
  "faster than polling — otherwise always background.",
  "",
  "Always background:",
  "- multi-step subagents (researcher, orchestrator, coder, explore, reviewer)",
  "- subagents that fan out to multiple tools",
  "- any subagent expected to take more than one second",
  "",
  "Sync only: a single grep/glob for confirmation before proceeding, or any",
  "case where you genuinely need the result inline to make your next decision.",
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
  { title: "Repository map", ids: ["banyan_repo_map"] },
  { title: "Verification", ids: ["banyan_test"] },
] as const

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

// Tool descriptions in the guide are compressed to a one-line routing hint.
// The full "Use when / Examples / Returns / Avoid when" text is already sent
// to the provider inside the tools array, so duplicating it verbatim in the
// system prompt only inflates every request (and every cache miss) — this was
// the dominant contributor to the 23K-token initial prompt measured in the
// chess benchmark vs 8.9K for upstream opencode.
const GUIDE_DESCRIPTION_LIMIT = 140

const compactDescription = (description: string): string => {
  const collapsed = description.replace(/\s+/g, " ").trim()
  const body = collapsed.startsWith("Use when:") ? collapsed.slice("Use when:".length).trim() : collapsed
  const sentenceEnd = body.search(/\.(?:\s+[A-Z]|$)/)
  const firstSentence = sentenceEnd === -1 ? body : body.slice(0, sentenceEnd + 1)
  const trimmed = firstSentence.trim()
  return trimmed.length <= GUIDE_DESCRIPTION_LIMIT
    ? trimmed
    : `${trimmed.slice(0, GUIDE_DESCRIPTION_LIMIT - 1).trimEnd()}…`
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
      entries.push(`- **${tool.id}** — ${compactDescription(tool.description)}`)
    }
    if (entries.length === 0) continue
    sections.push(`### ${family.title}\n\n${entries.join("\n")}`)
  }
  if (sections.length === 0) return ""
  return [
    "## BanyanCode tool guide",
    "",
    "The following tools are available in this session. Names and descriptions",
    "match the registry; consult the tool list the model receives for full",
    "input/output schemas.",
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

// Phase 5: the dynamic block — the graph-state line plus a SHORT per-task
// routing rule — is rendered right after the static policy and before the
// tool guide, so the model sees "what is the graph doing right now" and the
// routing rule before the catalog. The full routing ladder stays in the
// static policy; this is the one-line reminder the plan's "move the routing
// rule earlier" refers to.
const routingHeaderFor = (graph?: CodegraphSystemInput["graph"]): string => {
  const graphLine = graph === undefined ? "" : graphLineFor(graph)
  const rule = [
    "Pick the FIRST matching graph/repository tool for the current task before",
    "read/grep/bash. Only fall back after a graph tool YOU called reports",
    "not-found/empty/stale/failed, or for regex / non-code artifacts.",
  ].join("\n")
  return ["## Graph-first routing (ALWAYS)", graphLine, rule].filter((part) => part.length > 0).join("\n\n")
}

const loadImpl: Interface["load"] = Effect.fn("CodegraphSystemSource.load")(function* (input) {
  const tools = input?.tools ?? []
  const graph = input?.graph
  // Pinned: without tools AND without a graph state, the output is exactly
  // POLICY_TEXT (no trailing join artifacts).
  if (tools.length === 0 && graph === undefined) return POLICY_TEXT
  const routing = routingHeaderFor(graph)
  const guide = renderToolGuide(tools)
  return [POLICY_TEXT, routing, guide].filter((part) => part.length > 0).join("\n\n")
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

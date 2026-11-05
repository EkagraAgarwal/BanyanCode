/**
 * Codegraph system-prompt policy.
 *
 * Ported from v1 `packages/core/src/banyancode/codegraph-system-source.ts`.
 * In v1 this was a `SystemContext` source registered with the V2 runtime (and
 * a V1 adapter in `session/system.ts`). In the v2 plugin the equivalent seam
 * is `ctx.session.hook("context")` — see `src/codegraph/index.ts`, which
 * appends the rendered block to `event.system` right before provider dispatch.
 *
 * Two parts, exactly as v1:
 *   1. `POLICY_TEXT` — the static repository-intelligence-first policy.
 *   2. A per-session tool guide rendered from the tools that are actually
 *      registered (v1 read the tool registry; v2 passes the plugin's own
 *      tool list).
 *
 * `renderPolicy` renders both plus the live graph readout as one block (the
 * v1 legacy order). `policySystemParts` splits the static pair from that
 * readout so `banyancode_prompt_cache_stable_prefix` can emit the volatile
 * line as its own trailing part.
 */
export const POLICY_TEXT = [
  "## Repository intelligence is the canonical interface (ALWAYS)",
  "",
  "For ANY question about source code in this workspace, repository",
  "intelligence tools are the canonical search surface and MUST be used",
  "first, always. `grep`, `glob`, `shell`, and raw `read` are PRIMITIVES —",
  "they are fallbacks, not defaults — and are used if and only if",
  "absolutely necessary. You do not get to choose between them: for",
  "source-code questions, the first search operation MUST be a",
  "repository intelligence tool.",
  "",
  "### SOURCE-CODE SEARCH PROTOCOL (procedural, in order)",
  "",
  "STATE 1 — repository query: `repo op=query(query=<topic>)` is the",
  "entry point for any source-code question — locating a symbol, finding",
  "files about a feature, or discovering related tests/docs.",
  "",
  "STATE 2 — architecture: `repo op=explain(symbol=X)` for how a",
  "symbol fits in (entrypoints, dependents, tests, routes).",
  "",
  "STATE 3 — impact: before ANY non-trivial edit,",
  "`change_check op=blast_radius(target=X)` (counts) or",
  "`change_check op=preflight(target=X)` (full report: callers, tests,",
  "docs, configs, event bridges, HTTP routes).",
  "",
  "STATE 4 — read only what was returned: open the exact file:line range",
  "a repository tool surfaced. Read confirms a hit; it is not a search",
  "tool.",
  "",
  "STATE 5 — verify after edits: `change_check op=edit_plan(phase=\"after\")`",
  "to re-check blast radius, then run the affected tests.",
  "",
  "NEVER: grep/glob/shell -> read -> discover the graph later. Repository",
  "intelligence first, primitives only when the graph genuinely cannot",
  "answer.",
  "",
  "Cost: one repository call replaces 3-5 shell grep/read loops; repo",
  "tools return file:line answers you can edit. Hot tools (mounted):",
  "`code_find`, `repo`, `change_check`; anything else: `banyan_tool_search`.",
  "",
  "Bootstrap (BEFORE any other action):",
  "1. Graph/repo tools auto-trigger a build ONLY when the graph is missing",
  "   or structurally invalid (no meta row, empty file table, root/schema",
  "   mismatch). Don't run `codegraph op=build` on every session —",
  "   `codegraph op=status` returns `ready` when fresh.",
  "2. To refresh (you made edits, or want to re-index), call",
  "   `codegraph op=build` explicitly — manual builds beat waiting for an",
  "   auto-trigger. Check drift first with `codegraph op=staleness`.",
  "3. After the build, use repository tools first: `repo op=query`,",
  "   `repo op=explain`, `change_check op=blast_radius`,",
  "   `change_check op=preflight`.",
  "",
  "Tool routing ladder — pick the FIRST tool that matches the question:",
  "- 'Where is X declared / what does it do?' → `repo op=query(query=X)`",
  "  then `repo op=explain(symbol=X)` for the architectural slice",
  "- 'Who calls X? / what depends on X?' →",
  "  `change_check op=blast_radius(target=X)` (counts) or",
  "  `change_check op=preflight(target=X)` (full caller/test/route list)",
  "- 'Find the file for X' → `code_find(intent='find_file', target=X)`",
  "- 'Architecture / how does X fit in?' → `repo op=explain(symbol=X)`",
  "- 'What breaks if I edit file F?' → `change_check op=preflight(target=F)`",
  "- 'Follow the call chain from X' → `repo op=trace(symbol=X)`",
  "- 'Which tests cover X?' → `repo op=tests(symbol=X)`",
  "- 'Find anything about <topic>' → `repo op=query(query=<topic>)`",
  "- 'How risky is changing X?' → `change_check op=blast_radius(target=X)`",
  "  (counts) or `change_check op=preflight(target=X)` (full report)",
  "- 'Plan / verify an edit' →",
  "  `change_check op=edit_plan(phase='before' | 'after')`",
  "- 'Rename X safely' → `safe_rename(symbol=X)` (verify with",
  "  `change_check op=preflight` first)",
  "",
  "Routing categories — classify the question BEFORE choosing a tool:",
  "- SOURCE CODE question → repository intelligence FIRST, always.",
  "- NON-CODE artifact (configs, JSON, docs, lockfiles, build outputs) →",
  "  normal search is fine.",
  "- EXACT TEXT / REGEX match → `grep`.",
  "- FILENAME PATTERN → `glob`.",
  "- KNOWN FILE + KNOWN RANGE → `read` directly.",
  "",
  "`read`, `grep` and `glob` may answer with graph results: a whole-file read",
  "of a large code file returns its outline, an identifier grep returns",
  "definitions and usages, and a code-file glob returns indexed paths. Comments",
  "and strings are not included. Repeat the identical call to get the raw text.",
  "",
  "Only fall back to grep / glob / shell / read when — and only when —",
  "repository tools are genuinely exhausted:",
  "- a repository tool reports empty / stale / not-found (then re-run",
  "  `codegraph op=build` before resorting to primitives),",
  "- the user asks for regex or filename-pattern matching,",
  "- you're searching non-code artifacts (configs, JSON, docs, build outputs).",
  "`read` is only ever a confirmation step for a range a repository tool",
  "returned — never a search tool.",
].join("\n")

export interface ToolGuideInput {
  readonly id: string
  readonly description: string
}

const TOOL_FAMILIES = [
  { title: "Code graph", ids: ["codegraph", "code_find"] },
  { title: "Repository intelligence", ids: ["repo", "change_check", "safe_rename"] },
] as const

const MAX_DESCRIPTION_CHARS = 140

const firstSentence = (description: string): string => {
  const collapsed = description.replace(/\s+/g, " ").trim()
  const end = collapsed.search(/\.(?=\s+[A-Z(`]|$)/)
  const sentence = end === -1 ? collapsed : collapsed.slice(0, end + 1)
  return sentence.length > MAX_DESCRIPTION_CHARS ? `${sentence.slice(0, MAX_DESCRIPTION_CHARS)}…` : sentence
}

export function renderToolGuide(tools: ReadonlyArray<ToolGuideInput>): string {
  if (tools.length === 0) return ""
  const byId = new Map(tools.map((tool) => [tool.id, tool]))
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

export type GraphState = { readonly state: "ready" | "building" | "missing"; readonly symbols?: number }

/** One "Graph state:" line so the model can tell ready from absent. */
export const graphLineFor = (graph: GraphState): string => {
  if (graph.state === "ready") {
    const symbols = graph.symbols === undefined ? "N/A" : graph.symbols.toLocaleString()
    return `Graph state: ready (${symbols} symbols) — use code_find/repo now.`
  }
  if (graph.state === "building") {
    return "Graph state: building in background — first graph call will wait for the build."
  }
  return "Graph state: missing — the first graph call will build it."
}

export interface PolicyInput {
  readonly tools?: ReadonlyArray<ToolGuideInput>
  readonly graph?: GraphState
}

/** The block split at its volatility boundary (v1 `CodegraphParts`). */
export interface PolicyParts {
  /** Static policy + per-session tool guide: identical bytes on every turn. */
  readonly stable: string
  /** Live graph readout, which flips as the graph builds. */
  readonly dynamic?: string
}

export const renderPolicyParts = (input?: PolicyInput): PolicyParts => {
  const guide = renderToolGuide(input?.tools ?? [])
  const stable = guide.length === 0 ? POLICY_TEXT : `${POLICY_TEXT}\n\n${guide}`
  return input?.graph === undefined ? { stable } : { stable, dynamic: graphLineFor(input.graph) }
}

/** The whole block, exactly as v1 rendered it (policy + guide + graph line). */
export const renderPolicy = (input?: PolicyInput): string => {
  const parts = renderPolicyParts(input)
  return parts.dynamic === undefined ? parts.stable : `${parts.stable}\n\n${parts.dynamic}`
}

/**
 * Metadata marker the host request assembly reads: a part carrying it changes
 * between turns, so the assembly moves it behind every stable part and the
 * provider's cacheable prefix survives.
 */
export const VOLATILE_SYSTEM_METADATA = { system: { volatility: "dynamic" } } as const

export interface PolicySystemPart {
  readonly type: "text"
  readonly text: string
  readonly metadata?: Record<string, unknown>
}

/**
 * `banyancode_prompt_cache_stable_prefix` (default true), v1 WS3 parity:
 * emit the static policy + tool guide first and the live graph readout as its
 * own trailing part. A graph-state flip then changes bytes only after the
 * cacheable prefix. With the setting off the block stays one part in the
 * legacy interleaved position.
 */
export const policySystemParts = (
  input: PolicyInput & { readonly stablePrefix: boolean },
): ReadonlyArray<PolicySystemPart> => {
  const parts = renderPolicyParts(input)
  if (!input.stablePrefix || parts.dynamic === undefined)
    return [
      { type: "text", text: parts.dynamic === undefined ? parts.stable : `${parts.stable}\n\n${parts.dynamic}` },
    ]
  return [
    { type: "text", text: parts.stable, metadata: { banyancode: { stable: true, source: "codegraph" } } },
    {
      type: "text",
      text: parts.dynamic,
      metadata: { ...VOLATILE_SYSTEM_METADATA, banyancode: { source: "codegraph" } },
    },
  ]
}

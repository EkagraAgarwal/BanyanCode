/**
 * BanyanCode Codegraph System Source.
 *
 * Renders the policy + tool-guide block that is appended to the model-facing
 * system prompt when BanyanCode is enabled. The block has two parts:
 *
 *   1. The `## Codegraph-first search policy (PREFERRED)` section — a static,
 *      model-facing paragraph that tells the LLM to prefer graph + repository
 *      tools over grep/glob/bash in this workspace. Always emitted when
 *      BanyanCode is enabled (gated on `process.env.BANYANCODE_ENABLE !== "0"`).
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

export interface CodegraphToolDescription {
  readonly id: string
  readonly description: string
}

export interface CodegraphSystemInput {
  readonly location?: Location.Ref
  readonly agent?: AgentV2.Info
  readonly model?: ModelV2.Info
  readonly tools?: ReadonlyArray<CodegraphToolDescription>
}

export interface Interface {
  readonly load: (input?: CodegraphSystemInput) => Effect.Effect<string, never, never>
  readonly policyText: string
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphSystemSource") {}

const POLICY_TEXT = [
  "## Codegraph-first search policy (PREFERRED)",
  "",
  "Prefer BanyanCode graph + repository tools over grep/glob/bash for any code",
  "question in this workspace. The complete tool catalog with descriptions",
  "follows in this prompt.",
  "",
  "Defaults:",
  "1. Run `codegraph_build` once at the start of any multi-step task in a new",
  "   workspace. If you don't, `repository_query` will return `degraded: true`.",
  "2. For symbol/file lookup, start with `code_find` (five intents: definition,",
  "   callers, dependents, impact, find_file).",
  "3. For semantic/architectural context, escalate to `repository_query`,",
  "   `repository_explain`, `repository_trace`, `repository_tests`.",
  "4. Before any non-trivial edit, run `blast_radius` (summary) or `preflight`",
  "   (decision-ready: callers, tests, docs, configs, event bridges, HTTP routes).",
  "5. After edits, run `edit_plan(phase=\"after\")` to re-verify blast radius.",
  "",
  "Only fall back to grep / glob / bash when:",
  "- a graph tool explicitly reports empty / stale / not-found,",
  "- the user asks for regex or filename-pattern matching specifically,",
  "- you're searching non-code artifacts (configs, JSON, docs, build outputs).",
].join("\n")

const BANYAN_TOOL_IDS = [
  "codegraph_build",
  "codegraph_remove",
  "code_find",
  "repository_query",
  "repository_explain",
  "repository_trace",
  "repository_tests",
  "blast_radius",
  "preflight",
  "safe_rename",
  "edit_plan",
  "websearch_free",
] as const

const TOOL_FAMILIES = [
  { title: "Code graph", ids: ["codegraph_build", "codegraph_remove", "code_find"] },
  {
    title: "Repository intelligence",
    ids: ["repository_query", "repository_explain", "repository_trace", "repository_tests"],
  },
  { title: "Edit decision support", ids: ["blast_radius", "preflight", "safe_rename", "edit_plan"] },
  { title: "External research", ids: ["websearch_free"] },
] as const

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

function renderToolGuide(tools: ReadonlyArray<CodegraphToolDescription>): string {
  const allowed = new Set<string>(BANYAN_TOOL_IDS)
  const visible = tools.filter((tool) => allowed.has(tool.id))
  if (visible.length === 0) return ""
  const byId = new Map<string, CodegraphToolDescription>(visible.map((tool) => [tool.id, tool]))
  const sections: string[] = []
  for (const family of TOOL_FAMILIES) {
    const entries: string[] = []
    for (const id of family.ids) {
      const tool = byId.get(id)
      if (!tool) continue
      const description = tool.description.replace(/\s+/g, " ").trim()
      entries.push(`- **${tool.id}** — ${description}`)
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

const loadImpl: Interface["load"] = Effect.fn("CodegraphSystemSource.load")(function* (input) {
  const tools = input?.tools ?? []
  if (tools.length === 0) return POLICY_TEXT
  const guide = renderToolGuide(tools)
  if (guide.length === 0) return POLICY_TEXT
  return [POLICY_TEXT, guide].join("\n\n")
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

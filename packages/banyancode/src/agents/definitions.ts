import type { Permission } from "@opencode/schema/permission"
import { DEFAULT_MAX_SUBAGENTS, MAX_SUBAGENTS_LIMIT } from "../config/index.js"
import PROMPT_CODER from "./prompt/coder.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_ORCHESTRATOR from "./prompt/orchestrator.txt"
import PROMPT_RESEARCHER from "./prompt/researcher.txt"
import PROMPT_REVIEWER from "./prompt/reviewer.txt"
import PROMPT_SCOUT from "./prompt/scout.txt"

/**
 * BanyanCode agent definitions, ported from v1
 * (`packages/opencode/src/agent/agent.ts`).
 *
 * v1 permission strings are translated to v2 rules (`{ action, resource,
 * effect }`, last match wins — `Permission.evaluate` uses `findLast`). The
 * "agents with `*: deny` need explicit allow rows AFTER the deny" lesson is
 * encoded here by emitting the deny first and every allow after it.
 *
 * Tool renames v1 → v2 used throughout:
 *   bash → shell, task → subagent, apply_patch → patch (shares the `edit`
 *   action), list → glob, websearch_free → websearch (provider-based; the
 *   DuckDuckGo provider is registered by `src/websearch`).
 *
 * BanyanCode's own tools are matched by the `banyan_*` wildcard so tools added
 * by the codegraph/intel/verify/mesh workstreams are usable without another
 * agent release. v1 tool names are kept as well: those workstreams may port
 * them under their historical ids.
 */

export type AgentMode = "primary" | "subagent" | "all"

export interface AgentSpec {
  readonly id: string
  readonly description: string
  readonly mode: AgentMode
  readonly hidden?: boolean
  readonly system?: string
  /**
   * v1 defines no `steps` or `color` for BanyanCode agents; both stay unset so
   * the provider/v2 defaults apply. The fields exist so a future spec can set
   * them without changing the transform.
   */
  readonly steps?: number
  readonly color?: string
  readonly permissions: Permission.Ruleset
}

const allow = (action: string, resource = "*"): Permission.Rule => ({ action, resource, effect: "allow" })
const deny = (action: string, resource = "*"): Permission.Rule => ({ action, resource, effect: "deny" })
const ask = (action: string, resource = "*"): Permission.Rule => ({ action, resource, effect: "ask" })

/**
 * v2 asks before reading `.env` files. BanyanCode keeps that stricter default
 * (v1 allowed them) and re-appends these rows after any broad `read` allow so
 * the ask survives last-match resolution.
 */
const ENV_READ_POLICY: Permission.Ruleset = [
  ask("read", "*.env"),
  ask("read", "*.env.*"),
  allow("read", "*.env.example"),
]

/**
 * BanyanCode tool actions. `banyan_*` is the wildcard over the plugin's tool
 * namespace; the rest are the v1 ids the ported workstreams may keep.
 */
const BANYAN_TOOLS: readonly string[] = [
  "banyan_*",
  "code_find",
  "repo",
  "change_check",
  "safe_rename",
  "codegraph",
  "banyan_typecheck",
  "banyan_test",
  "banyan_lint",
  "banyan_compile",
  "banyan_tool_search",
  "system_status",
  "systeminfo",
]

/** Mesh tools (workstream 3f). Allowed explicitly so a `*: deny` base does not lock them out. */
const MESH_TOOLS: readonly string[] = ["mesh_status", "mesh_control", "mesh_subscribe", "subagent_message", "shared_memory"]

const allows = (actions: readonly string[]): Permission.Rule[] => actions.map((action) => allow(action))

const readOnly = (actions: readonly string[], extra: readonly Permission.Rule[] = []): Permission.Ruleset => [
  deny("*"),
  ...allows(actions),
  ...extra,
  ...ENV_READ_POLICY,
]

const render = (template: string, vars: Readonly<Record<string, string>>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? `{{${key}}}`)

export const DEFAULT_MAX_SUBAGENTS_CAP = DEFAULT_MAX_SUBAGENTS
export const MAX_SUBAGENTS_CAP = MAX_SUBAGENTS_LIMIT

/** Clamp `banyancode_max_subagents` the same way `summarize` does. */
export const clampSubagents = (value: number | undefined): number => {
  const raw = Number.isFinite(value) ? Math.trunc(value as number) : DEFAULT_MAX_SUBAGENTS_CAP
  return Math.min(MAX_SUBAGENTS_CAP, Math.max(1, raw))
}

/**
 * The BanyanCode agent set. Existing v2 agents (`build`, `plan`, `explore`,
 * `compaction`, `title`, `summary`) are updated in place; the rest are created
 * from `Agent.Info.default`.
 */
export const definitions = (maxSubagents: number): readonly AgentSpec[] => {
  const vars = { maxSubagents: String(maxSubagents) }
  return [
    {
      id: "build",
      description: "The default agent. Executes tools based on configured permissions.",
      mode: "primary",
      // v1 parity: no custom prompt; the provider prompt applies.
      permissions: [
        allow("question"),
        // v1 `goal` tool (v2 default permissions would otherwise ask).
        allow("goal"),
        deny("subagent"),
        allow("subagent", "explore"),
        allow("subagent", "scout"),
        allow("subagent", "coder"),
        allow("subagent", "researcher"),
        ...allows(BANYAN_TOOLS),
        ...allows(MESH_TOOLS),
      ],
    },
    {
      id: "plan",
      description: "Read-only agent for exploring the codebase and planning work before implementation.",
      mode: "primary",
      permissions: [
        allow("question"),
        deny("subagent"),
        allow("subagent", "scout"),
        allow("subagent", "explore"),
        allow("subagent", "researcher"),
        // Core's plan transform runs first and denies `edit`; these allows land
        // after it, so plan files stay writable (v1 allowed both project dirs).
        allow("edit", ".banyancode/plans/*"),
        allow("edit", ".opencode/plans/*"),
        // Plan is read-only, so it gets the graph readers but not the tools that
        // write files or run project scripts. A shell command can write anything.
        ...allows(["code_find", "repo", "change_check", "banyan_tool_search", "system_status", "systeminfo"]),
        deny("safe_rename"),
        { action: "codegraph", resource: "*", effect: "ask" },
        { action: "shell", resource: "*", effect: "ask" },
      ],
    },
    {
      id: "explore",
      description:
        'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.',
      mode: "subagent",
      system: render(PROMPT_EXPLORE, vars),
      permissions: readOnly(
        ["read", "grep", "glob", "webfetch", "websearch", "external_directory", ...BANYAN_TOOLS, ...MESH_TOOLS],
      ),
    },
    {
      id: "coder",
      description:
        "Focused executor agent. Makes targeted code changes using codegraph-first analysis. Single task, recon-only delegation to explore/researcher.",
      mode: "subagent",
      system: PROMPT_CODER,
      permissions: [
        deny("subagent"),
        allow("subagent", "explore"),
        allow("subagent", "researcher"),
        allow("question"),
        allow("todowrite"),
        ...allows(BANYAN_TOOLS),
        ...allows(MESH_TOOLS),
      ],
    },
    {
      id: "scout",
      description: "Fast reconnaissance agent. Single shot, return within 3 tool calls. Read-only exploration.",
      mode: "subagent",
      system: render(PROMPT_SCOUT, vars),
      permissions: readOnly(
        ["read", "grep", "glob", "webfetch", "websearch", "external_directory", ...BANYAN_TOOLS, ...MESH_TOOLS],
        [deny("todowrite"), deny("subagent"), deny("edit")],
      ),
    },
    {
      id: "reviewer",
      description:
        "Reviews code changes with a clean context. Read-only — does not edit, write, or execute. Returns pass / fail / blocked with reasoning.",
      mode: "subagent",
      system: PROMPT_REVIEWER,
      permissions: [
        deny("edit"),
        deny("shell"),
        deny("websearch"),
        deny("subagent"),
        deny("todowrite"),
        deny("question"),
        deny("shared_memory"),
        deny("mesh_control"),
        deny("mesh_subscribe"),
        deny("subagent_message"),
        ...allows(["read", "grep", "glob", "webfetch", ...BANYAN_TOOLS]),
        ...ENV_READ_POLICY,
      ],
    },
    {
      id: "researcher",
      description:
        "Read-only subagent. Performs free web search via DuckDuckGo and reads external docs. Writes findings to shared_memory.",
      mode: "subagent",
      system: render(PROMPT_RESEARCHER, vars),
      permissions: [
        deny("edit"),
        deny("shell"),
        deny("subagent"),
        ...allows(["read", "grep", "glob", "webfetch", "websearch", ...BANYAN_TOOLS, ...MESH_TOOLS]),
        ...ENV_READ_POLICY,
      ],
    },
    {
      id: "orchestrator",
      description:
        "Decomposes complex tasks, fans out to parallel subagents, coordinates via shared memory and peer messages.",
      mode: "primary",
      system: render(PROMPT_ORCHESTRATOR, vars),
      permissions: [
        deny("subagent"),
        allow("subagent", "researcher"),
        allow("subagent", "coder"),
        allow("subagent", "explore"),
        allow("subagent", "scout"),
        allow("subagent", "reviewer"),
        allow("todowrite"),
        allow("question"),
        allow("goal"),
        ...allows(BANYAN_TOOLS),
        ...allows(MESH_TOOLS),
      ],
    },
    {
      id: "compaction",
      description: "Compacts the conversation into an anchored summary.",
      mode: "primary",
      hidden: true,
      permissions: [deny("*"), allow("codegraph_staleness"), allow("mesh_status")],
    },
    {
      id: "title",
      description: "Names conversations.",
      mode: "primary",
      hidden: true,
      permissions: [deny("*"), allow("codegraph_staleness"), allow("mesh_status")],
    },
    {
      id: "summary",
      description: "Summarizes what was done in a conversation.",
      mode: "primary",
      hidden: true,
      permissions: [deny("*"), allow("codegraph_staleness"), allow("mesh_status")],
    },
  ]
}

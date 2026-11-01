import type { AgentEditor } from "@opencode/plugin/effect/agent"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import type { Permission } from "@opencode/schema/permission"
import { Provider } from "@opencode/schema/provider"
import { Effect, type Types } from "effect"
import type { Loaded } from "../config/index.js"
import type { AgentConfig } from "../config/index.js"
import { clampSubagents, definitions } from "./definitions.js"
import { resolveVariant } from "./thinking.js"

/**
 * Snapshot captured before a transform is registered (transform callbacks are
 * synchronous, so every effectful read happens here). The plugin refreshes the
 * snapshot on `config.updated` / `model.updated` and calls `ctx.agent.reload()`.
 */
export interface AgentState {
  readonly maxSubagents: number
  readonly overrides: Readonly<Record<string, AgentConfig>>
  /** `providerID/modelID` → variant ids the catalog advertises. */
  readonly variants: ReadonlyMap<string, readonly string[]>
  readonly thinkingDefault?: string
}

export interface ModelCatalogLike {
  list: (input?: { readonly types?: ReadonlyArray<string> }) => Effect.Effect<
    { readonly data: ReadonlyArray<Model.Info> },
    unknown
  >
}

type MutableAgent = Types.DeepMutable<Agent.Info>

/** `provider/model` (v1 syntax) or `provider/model#variant` (v2 syntax). */
export const parseModelRef = (
  value: string,
): { providerID: Provider.ID; modelID: Model.ID; variant?: string } | undefined => {
  const hash = value.indexOf("#")
  const variant = hash === -1 ? undefined : value.slice(hash + 1)
  const body = hash === -1 ? value : value.slice(0, hash)
  const slash = body.indexOf("/")
  if (slash <= 0 || slash === body.length - 1) return undefined
  if (variant !== undefined && (variant.length === 0 || variant.includes("#"))) return undefined
  return {
    providerID: Provider.ID.make(body.slice(0, slash)),
    modelID: Model.ID.make(body.slice(slash + 1)),
    ...(variant === undefined ? {} : { variant }),
  }
}

const VALID_EFFECTS = new Set<Permission.Effect>(["allow", "ask", "deny"])

/**
 * v1 `agent.<id>.permission` is a flat `{ action: "allow" | "ask" | "deny" }`
 * record (the v2 BanyanConfig schema keeps that shape). Unknown values are
 * dropped rather than silently becoming an ask.
 */
export const permissionRules = (input: Readonly<Record<string, string>>): Permission.Ruleset =>
  Object.entries(input).flatMap(([action, effect]) => {
    if (!VALID_EFFECTS.has(effect as Permission.Effect)) return []
    return [{ action, resource: "*", effect: effect as Permission.Effect }]
  })

const applyModel = (agent: MutableAgent, override: AgentConfig, state: AgentState) => {
  const pinned = override.model === undefined ? undefined : parseModelRef(override.model)
  // A malformed model string must not wipe the agent's existing model.
  if (override.model !== undefined && pinned === undefined) return
  const providerID = pinned?.providerID ?? agent.model?.providerID
  const modelID = pinned?.modelID ?? agent.model?.id
  if (providerID === undefined || modelID === undefined) return
  const available = state.variants.get(`${providerID}/${modelID}`)
  // An existing variant belongs to the previous model, so only carry it when
  // the model did not change.
  const current = pinned === undefined ? agent.model?.variant : undefined
  const thinking = override.thinking ?? (agent.mode === "subagent" ? state.thinkingDefault : undefined)
  // v1 precedence: explicit `variant` (or `model#variant`) wins over `thinking`.
  const explicit = override.variant ?? pinned?.variant
  const variant = resolveVariant({
    ...(explicit === undefined ? {} : { variant: explicit }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(current === undefined ? {} : { current }),
    ...(available === undefined ? {} : { available }),
  })
  agent.model = {
    providerID,
    id: modelID,
    ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
  }
}

/**
 * Apply `banyancode.json` per-agent overrides after the definitions, so they
 * win (v2 resolves permissions with `findLast`).
 *
 * `enabled: false` disables subagents only, matching v1 (`get` returned
 * undefined and `list` filtered subagents; primaries ignored the flag).
 */
export const applyOverrides = (editor: AgentEditor, state: AgentState) => {
  for (const [id, override] of Object.entries(state.overrides)) {
    if (override.enabled === false) {
      const current = editor.get(id)
      if (current?.mode === "subagent") editor.remove(id)
      continue
    }
    // v1 created config-defined agents with mode "all" (only overridden when
    // the config names a mode). `Agent.Info.default` defaults to "primary".
    const exists = editor.get(id) !== undefined
    editor.update(id, (agent) => {
      if (!exists && override.mode === undefined) agent.mode = "all"
      if (override.mode !== undefined) agent.mode = override.mode
      if (override.prompt !== undefined) agent.system = override.prompt
      // `options` stays stored-only, as in v1: v2 has no agent-scoped provider
      // options seam (`agent.request` is not consumed by the request builder
      // yet), so applying it would silently do nothing.
      if (override.permission !== undefined) agent.permissions.push(...permissionRules(override.permission))
      applyModel(agent, override, state)
    })
  }
}

/**
 * Materialize the BanyanCode agent set into the v2 agent editor. New agents are
 * created from `Agent.Info.default` (which supplies the allow-all base plus the
 * `.env` asks); existing v2 agents keep their earlier rules and receive ours on
 * top.
 */
export const apply = (editor: AgentEditor, state: AgentState) => {
  for (const spec of definitions(state.maxSubagents)) {
    editor.update(spec.id, (agent) => {
      agent.mode = spec.mode
      agent.description = spec.description
      if (spec.hidden !== undefined) agent.hidden = spec.hidden
      if (spec.system !== undefined) agent.system = spec.system
      if (spec.steps !== undefined) agent.steps = spec.steps
      if (spec.color !== undefined) agent.color = spec.color
      agent.permissions.push(...spec.permissions)
    })
  }
  applyOverrides(editor, state)
}

/** Build the state from a loaded `banyancode.json` plus the model catalog. */
export const snapshot = (
  config: Loaded["config"],
  variants: ReadonlyMap<string, readonly string[]>,
): AgentState => ({
  maxSubagents: clampSubagents(config.banyancode_max_subagents),
  overrides: config.agent ?? {},
  variants,
  ...(config.banyancode_thinking_default === undefined
    ? {}
    : { thinkingDefault: config.banyancode_thinking_default }),
})

/**
 * Capture `providerID/modelID → variant ids` from the model catalog. A missing
 * catalog (providers still loading) yields an empty map: thinking is then
 * omitted instead of guessed, and the next `model.updated` refresh retries.
 */
export const loadVariants = (models: ModelCatalogLike): Effect.Effect<ReadonlyMap<string, readonly string[]>> =>
  models.list({ types: ["chat"] }).pipe(
    Effect.map(
      (output) =>
        new Map(
          output.data.map((model) => [
            `${model.providerID}/${model.id}`,
            model.variants.map((variant) => variant.id as string),
          ]),
        ),
    ),
    Effect.catchCause(() => Effect.succeed(new Map<string, readonly string[]>())),
  )

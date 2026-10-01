export * as JevTurn from "./jev-turn"

import { ask, feature } from "./jev"
import type { Config, Usage } from "./jev"

// Bounded Jev turn-routing policy.
//
// Jev never generates text: `planTurn` asks two enumerable Choice questions
// (turn kind, model tier) about ONE shared bounded state in a SINGLE `ask`
// call and maps the answers onto `{ kind, tier, model?, thinking?, ...meta }`.
// Anything else — disabled, missing key, failure, low confidence, invalid
// answer, over budget, cancelled — returns `undefined` and the caller keeps
// its authoritative model. Callers escalate `undefined` back to the default
// path.
//
// Per-item questions about one shared state (never packed bulk) per the
// reference benchmark note in the integration plan.
//
// Low-dependency by design: the only runtime imports are the sibling `./jev`
// client (`ask`, `feature`) via direct file import, never the barrel, so no
// TDZ cycle. Config reuses the client's `Config` type — the full
// `BanyanConfig.Info` is assignable without importing the v1 schema.
// Thinking values are validated against ThinkingLevelSchema at the config
// boundary and resolved downstream via `Thinking.resolveThinkingVariant`;
// this module passes them through as strings. No Auth integration in this
// wave (lead/successor owns it).

export const TURN_KINDS = ["read_only", "small_edit", "multi_file_edit", "needs_plan", "other"] as const
export type TurnKind = (typeof TURN_KINDS)[number]

export const TURN_TIERS = ["fast", "strong"] as const
export type TurnTier = (typeof TURN_TIERS)[number]

/** Automatic feature id this policy gates on. */
export const TURN_FEATURE = "turn-routing"

/** Minimum Choice confidence to act on; below this the answer is uncertainty. */
export const MIN_CONFIDENCE = 0.6

/** Upper bound on the task text sent as Jev state (characters, not tokens). */
export const MAX_STATE_CHARS = 4_000

/** Default per-request abort budget in ms (matches the explorer default). */
export const DEFAULT_TIMEOUT_MS = 1_500

export interface TurnPlan {
  readonly kind: TurnKind
  readonly tier: TurnTier
  /** From `banyancode_jev_model_tiers`; absent when tiers are unconfigured. */
  readonly model?: string
  /** Thinking level or explicit variant id; resolved downstream, never a 400. */
  readonly thinking?: string
  /** Result metadata passthrough from the `ask` call. */
  readonly usage?: Usage
  readonly latencyMs?: number
  readonly cached?: boolean
}

/** Policy config is the client's config; full `BanyanConfig.Info` assigns. */
export type TurnPolicyConfig = Config

export interface PlanTurnInput {
  /** Latest user task text; bounded and secret-filtered before sending. */
  readonly task: string
  readonly config?: TurnPolicyConfig
  readonly env?: Record<string, string | undefined>
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>
  /** Explicit caller credential; counts as connecting Jev (see `ask`). */
  readonly apiKey?: string
  readonly sessionID?: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  /** Automatic feature id to gate on; default `turn-routing`. */
  readonly feature?: string
  /** Decision scope label; recorded in the bounded state, forwarded to `ask`. */
  readonly scope?: string
}

const KIND_QUESTION = "What kind of work does this task require?"
const KIND_CRITERIA: Readonly<Record<TurnKind, string>> = {
  read_only: "No file writes: questions, exploration, explanation, or search.",
  small_edit: "A small change confined to a single file.",
  multi_file_edit: "Coordinated changes across multiple files.",
  needs_plan: "Ambiguous or large work that needs a plan before any edit.",
  other: "None of the above fit.",
}

const TIER_QUESTION = "Which model tier fits this turn?"
const TIER_CRITERIA: Readonly<Record<TurnTier, string>> = {
  fast: "Routine, well-specified work a small model can do.",
  strong: "Subtle, ambiguous, or high-stakes work needing a strong model.",
}

export const isTurnKind = (value: unknown): value is TurnKind =>
  typeof value === "string" && (TURN_KINDS as readonly string[]).includes(value)

export const isTurnTier = (value: unknown): value is TurnTier =>
  typeof value === "string" && (TURN_TIERS as readonly string[]).includes(value)

/**
 * Policy gate for automatic turn routing. Defers to the client's `feature()`
 * (explicit per-feature flags win, otherwise aggressive profile only,
 * unknown automatic features default off). An explicit caller `apiKey`
 * counts as connecting Jev, mirroring `ask`.
 */
export const isTurnRoutingEnabled = (
  config?: TurnPolicyConfig,
  env?: Record<string, string | undefined>,
  featureName: string = TURN_FEATURE,
  apiKey?: string,
): boolean => {
  if (config?.banyancode_jev_enabled === false) return false
  const keyedEnv = apiKey?.trim() ? { ...env, BANYANCODE_JEV_API_KEY: apiKey.trim() } : env
  return feature(config, keyedEnv, featureName)
}

// Defense in depth: the client redacts at the network boundary (worker A).
// Strip obvious secret values here too so they never reach the state string.
const redactSecrets = (text: string): string =>
  text
    .replace(/sk-[A-Za-z0-9-_]{16,}/g, "[redacted]")
    .replace(/(api[_-]?key|secret|token|passwd|password)(\s*[:=]\s*)([^\s"'`]+)/gi, "$1$2[redacted]")

const boundState = (task: string, scope?: string): string => {
  const label = scope?.trim() ? `scope: ${scope.trim().slice(0, 128)}\n` : ""
  return `${label}task: ${redactSecrets(task).slice(0, MAX_STATE_CHARS)}`
}

/**
 * Bounded turn-routing decision in one `ask` call. Never throws: every
 * disable, failure, or uncertain answer resolves `undefined` — the caller
 * keeps its authoritative model and request bytes.
 *
 * Economics gate: when no execution tier is configured (`fast` and `strong`
 * both absent/blank) the decision cannot change execution, so return
 * `undefined` without paying for a log-only answer.
 */
export const planTurn = async (input: PlanTurnInput): Promise<TurnPlan | undefined> => {
  try {
    if (!input || typeof input.task !== "string" || input.task.trim() === "") return undefined
    if (input.signal?.aborted) return undefined
    const name = input.feature?.trim() || TURN_FEATURE
    if (!isTurnRoutingEnabled(input.config, input.env, name, input.apiKey)) return undefined
    const tiers = input.config?.banyancode_jev_model_tiers
    if (!tiers?.fast?.trim() && !tiers?.strong?.trim()) return undefined

    const result = await ask({
      state: boundState(input.task, input.scope ?? input.sessionID),
      questions: {
        "turn-kind": { type: "choice", instructions: KIND_QUESTION, criteria: { ...KIND_CRITERIA } },
        "turn-tier": { type: "choice", instructions: TIER_QUESTION, criteria: { ...TIER_CRITERIA } },
      },
      config: input.config,
      env: input.env,
      fetch: input.fetch,
      apiKey: input.apiKey,
      sessionID: input.sessionID,
      signal: input.signal,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      feature: name,
      scope: input.scope,
    })
    if (!result.ok) return undefined
    const kindAnswer = result.answers["turn-kind"]
    const tierAnswer = result.answers["turn-tier"]
    if (kindAnswer?.type !== "choice" || tierAnswer?.type !== "choice") return undefined
    if (!isTurnKind(kindAnswer.choice) || kindAnswer.confidence < MIN_CONFIDENCE) return undefined
    if (!isTurnTier(tierAnswer.choice) || tierAnswer.confidence < MIN_CONFIDENCE) return undefined

    const model = tierAnswer.choice === "fast" ? tiers?.fast : tiers?.strong
    const thinking = tierAnswer.choice === "fast" ? tiers?.fastThinking : tiers?.strongThinking
    return {
      kind: kindAnswer.choice,
      tier: tierAnswer.choice,
      ...(model === undefined ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      latencyMs: result.latencyMs,
      ...(result.cached === undefined ? {} : { cached: result.cached }),
    }
  } catch {
    return undefined
  }
}

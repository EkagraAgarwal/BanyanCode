export * as JevMemory from "./jev-memory"

import type { MemoryEntry } from "./types"
import { unwrapMemoryValue } from "./memory-payload"
import { Jev } from "./jev"
import { Duration, Effect, Option } from "effect"

// Opt-in Jev rerank for memory retrieval ("context-rerank").
//
// One Jev `ask` per query+candidate pair: the state carries the query plus a
// single candidate, and the two questions (Noul relevance + Score utility)
// judge that one candidate. Packed multi-candidate states are intentionally
// avoided: per-item judgments score higher on the reference benchmark.
// The caller (memory-retrieval) owns gating, shortlist bounds, concurrency,
// deadlines, and order preservation; this module only builds states,
// questions, and scores.

export const FEATURE = "context-rerank"
/** Bounded shortlist: at most this many lexical-top candidates are scored. */
export const MAX_SHORTLIST = 8
/** Max concurrent Jev requests while scoring the shortlist. */
export const MAX_INFLIGHT = 4
/** Per-candidate Jev request deadline (ask enforces it end to end). */
export const REQUEST_TIMEOUT_MS = 3_000
/** Whole-rerank wall-clock bound; exceeding it keeps lexical order. */
export const RERANK_DEADLINE_MS = 8_000
/** Candidate body chars embedded in a scoring state. */
export const MAX_STATE_BODY_CHARS = 2_000
/** Query chars embedded in a scoring state (query is unbounded caller input). */
export const MAX_STATE_QUERY_CHARS = 2_000
/** Title chars embedded in a scoring state. */
export const MAX_STATE_TITLE_CHARS = 500
/** Key chars embedded in a scoring state. */
export const MAX_STATE_KEY_CHARS = 500
/** Default Jev request scope for rerank calls (memory visibility scope is NOT a turn identity). */
export const DEFAULT_REQUEST_SCOPE = "memory-rerank"
/**
 * Policy-specific uncertainty gates (NOT correctness probabilities):
 * a Score answer below this confidence, or a Noul answer this close to
 * 0.5, carries no signal and the candidate keeps lexical order.
 */
export const MIN_SCORE_CONFIDENCE = 0.8
export const NOUL_DECIDED_LOW = 0.3
export const NOUL_DECIDED_HIGH = 0.7

export const RELEVANCE_QUESTION_ID = "relevance"
export const UTILITY_QUESTION_ID = "utility"

/**
 * Score utility levels. Answers use level-index strings "0"..levels-1 as
 * probability/legend keys with score in [0, levels-1].
 */
export const UTILITY_LEVELS = ["irrelevant", "tangential", "background", "relevant", "directly-answers"] as const

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text

/**
 * Raw-SQL rows (`MemoryRepo.searchRanked`) bypass Drizzle's JSON mapping, so
 * `value`/`tags` can arrive as JSON strings instead of parsed objects. Parse
 * defensively; fall back to the raw input when parsing fails.
 */
const safePayload = (value: unknown, key: string) => {
  if (typeof value === "string") {
    try {
      return unwrapMemoryValue(JSON.parse(value), key)
    } catch {
      return unwrapMemoryValue(value, key)
    }
  }
  return unwrapMemoryValue(value, key)
}

const safeTags = (tags: unknown): string[] => {
  if (Array.isArray(tags)) return tags.filter((tag): tag is string => typeof tag === "string")
  if (typeof tags === "string") {
    try {
      const parsed: unknown = JSON.parse(tags)
      if (Array.isArray(parsed)) return parsed.filter((tag): tag is string => typeof tag === "string")
    } catch {
      return []
    }
    return []
  }
  return []
}

export const buildCandidateState = (query: string, entry: MemoryEntry): string => {
  const payload = safePayload(entry.value, entry.key)
  const trimmedQuery = query.trim() === "" ? "(empty)" : query.trim()
  return [
    `query: ${truncate(trimmedQuery, MAX_STATE_QUERY_CHARS)}`,
    "---",
    `candidate: ${truncate(entry.key, MAX_STATE_KEY_CHARS)}`,
    `kind: ${payload.kind} / importance: ${payload.importance} / confidence: ${payload.confidence} / source: ${payload.source.type}`,
    `scope: ${entry.scope}${entry.sessionID ? ` / session: ${entry.sessionID}` : ""}`,
    `title: ${truncate(payload.title, MAX_STATE_TITLE_CHARS)}`,
    `body: ${truncate(payload.body, MAX_STATE_BODY_CHARS)}`,
  ].join("\n")
}

export const relevanceQuestions = (): Record<string, Jev.Question> => ({
  [RELEVANCE_QUESTION_ID]: {
    type: "noul",
    instructions: "Is this memory candidate relevant to answering the query? Judge only the candidate shown in the state.",
    criteria: {
      true: "The candidate helps answer the query or records a decision, convention, or fact the query asks about.",
      false: "The candidate is unrelated to the query or too vague to act on.",
    },
  },
  [UTILITY_QUESTION_ID]: {
    type: "score",
    instructions: "How useful is this memory candidate for answering the query? Higher means more directly useful.",
    criteria: [...UTILITY_LEVELS],
  },
})

/** Blend Noul relevance with normalized Score utility; undefined on any mismatch (uncertainty). */
export const combinedScore = (answers: Readonly<Record<string, Jev.Answer>>): number | undefined => {
  const relevance = answers[RELEVANCE_QUESTION_ID]
  const utility = answers[UTILITY_QUESTION_ID]
  if (!relevance || relevance.type !== "noul") return undefined
  if (!utility || utility.type !== "score") return undefined
  if (!Number.isFinite(relevance.noul) || relevance.noul < 0 || relevance.noul > 1) return undefined
  if (relevance.noul > NOUL_DECIDED_LOW && relevance.noul < NOUL_DECIDED_HIGH) return undefined
  if (!Number.isFinite(utility.confidence) || utility.confidence < MIN_SCORE_CONFIDENCE) return undefined
  const levels = UTILITY_LEVELS.length
  if (!Number.isFinite(utility.score) || utility.score < 0 || utility.score > levels - 1) return undefined
  return (relevance.noul + utility.score / (levels - 1)) / 2
}

/**
 * Pinned critical facts keep their exact lexical slots during rerank.
 * Explicit `pinned`/`critical` tags pin; otherwise importance-high entries
 * (user-marked critical) are protected. Everything else is rerankable.
 */
export const isProtected = (entry: MemoryEntry): boolean => {
  if (safeTags(entry.tags).some((tag) => tag === "pinned" || tag === "critical")) return true
  return safePayload(entry.value, entry.key).importance === "high"
}

export interface ScoreCandidateInput {
  readonly query: string
  readonly entry: MemoryEntry
  readonly config?: Jev.Config
  readonly env?: Jev.Env
  readonly fetch?: Jev.Fetch
  readonly sessionID?: string
  readonly scope?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/**
 * Score one query+candidate pair via the Jev client boundary. Never throws:
 * any failure or invalid answer is uncertainty (undefined) and the caller
 * keeps lexical order. No USD budget is set here; the caller's config flows
 * through to the client untouched. Pass the caller's AbortSignal so a
 * retrieval-level deadline interrupts the physical request instead of
 * leaving it running in the background.
 */
export const scoreCandidate = async (input: ScoreCandidateInput): Promise<number | undefined> => {
  try {
    const result = await Jev.ask({
      state: buildCandidateState(input.query, input.entry),
      questions: relevanceQuestions(),
      ...(input.config === undefined ? {} : { config: input.config }),
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      feature: FEATURE,
      timeoutMs: input.timeoutMs ?? REQUEST_TIMEOUT_MS,
    })
    if (!result.ok) return undefined
    return combinedScore(result.answers)
  } catch {
    return undefined
  }
}

export interface RerankInput extends Omit<ScoreCandidateInput, "entry"> {
  readonly entries: MemoryEntry[]
}

/** Reorder only the bounded unprotected shortlist, retaining every entry. */
export const rerank = (input: RerankInput): Effect.Effect<MemoryEntry[]> =>
  Effect.gen(function* () {
    const config = input.config ?? {}
    if (!Jev.feature(config, input.env, FEATURE)) return input.entries
    if (config.banyancode_jev_budget?.perTurnCalls !== undefined && !input.scope) return input.entries
    if (config.banyancode_jev_budget?.perSessionUsd !== undefined && !input.sessionID) return input.entries
    const slots = input.entries.flatMap((entry, index) => isProtected(entry) ? [] : [{ entry, index }]).slice(0, MAX_SHORTLIST)
    if (slots.length < 2) return input.entries
    const controller = new AbortController()
    const results = yield* Effect.forEach(slots, (slot) =>
      Effect.promise(() => scoreCandidate({ ...input, entry: slot.entry, signal: controller.signal })),
      { concurrency: MAX_INFLIGHT },
    ).pipe(
      Effect.timeout(Duration.millis(RERANK_DEADLINE_MS)),
      Effect.option,
      Effect.ensuring(Effect.sync(() => controller.abort())),
    )
    if (Option.isNone(results) || results.value.some((score) => score === undefined)) return input.entries
    const ranked = slots.map((slot, index) => ({ ...slot, score: results.value[index] ?? 0 }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
    const entries = [...input.entries]
    slots.forEach((slot, index) => { entries[slot.index] = ranked[index].entry })
    return entries
  })

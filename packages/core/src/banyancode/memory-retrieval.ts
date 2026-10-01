/**
 * BanyanCode Memory Retrieval (Phase 3).
 *
 * Intent-aware routing + multi-signal ranking over the FTS-backed search.
 *
 * The retrieval layer:
 *
 *   1. Classifies the incoming query into one of:
 *      - "code-centric"  (default; prefer codegraph over memory)
 *      - "history"       (project history; memory primary)
 *      - "preference"    (style conventions; memory primary)
 *      - "continuation"  (resume work; session summary primary)
 *   2. Decides whether to even hit memory — based on Section 19 ("do not
 *      retrieve on every turn").
 *   3. Builds an FTS query, runs `MemoryRepo.searchRanked`, and re-ranks the
 *      results using deterministic per-row signals (importance, confidence,
 *      scope match, recency, kind priority, source authority).
 *   4. Optionally applies an opt-in Jev semantic rerank ("context-rerank",
 *      see ./jev-memory.ts) over the lexical order. The lexical signals
 *      above stay intrinsic and deterministic; Jev only reorders
 *      non-protected slots, never deletes or promotes entries, and any
 *      uncertainty falls back to the lexical order.
 */

import { Context, Duration, Effect, Layer, Option } from "effect"
import type { MemoryPayloadV1 } from "./memory-payload"
import type { MemoryEntry } from "./types"
import { MemoryRepo } from "./memory-repo"
import { unwrapMemoryValue } from "./memory-payload"
import { BanyanConfigService } from "./banyan-config"
import { Jev } from "./jev"
import { JevMemory } from "./jev-memory"

export type QueryIntent = "code-centric" | "history" | "preference" | "continuation"

const HISTORY_KEYWORDS = [
  "why",
  "decided",
  "switched",
  "previously",
  "before",
  "history",
  "switched from",
  "decision",
  "rationale",
  "chose",
  "rejected",
]

const PREFERENCE_KEYWORDS = [
  "prefer",
  "convention",
  "style",
  "format",
  "should i",
  "should we",
  "how should",
  "guideline",
  "approach",
]

const CONTINUATION_KEYWORDS = [
  "continue",
  "resume",
  "pick up",
  "where we left off",
  "yesterday",
  "earlier",
  "last time",
]

export interface ClassifyQueryInput {
  query: string
}

export interface ClassifyQueryResult {
  intent: QueryIntent
  reasons: string[]
}

export const classifyQuery = (input: ClassifyQueryInput): ClassifyQueryResult => {
  const lower = input.query.toLowerCase()
  const reasons: string[] = []
  if (CONTINUATION_KEYWORDS.some((k) => lower.includes(k))) {
    reasons.push("continuation-keyword")
    return { intent: "continuation", reasons }
  }
  if (PREFERENCE_KEYWORDS.some((k) => lower.includes(k))) {
    reasons.push("preference-keyword")
    return { intent: "preference", reasons }
  }
  if (HISTORY_KEYWORDS.some((k) => lower.includes(k))) {
    reasons.push("history-keyword")
    return { intent: "history", reasons }
  }
  reasons.push("default-code-centric")
  return { intent: "code-centric", reasons }
}

export interface RetrieveInput {
  query: string
  scope?: "global" | "session"
  sessionID?: string
  limit?: number
  status?: "active"
  /** Caller-supplied override; bypasses classifier. */
  intentOverride?: QueryIntent
  /** Injected fetch for the opt-in Jev rerank (tests); real network otherwise. */
  fetch?: Jev.Fetch
  /** Env for Jev gating/client (defaults to process.env); avoids global mutation in tests. */
  env?: Jev.Env
  /** Per-candidate Jev request deadline in ms (default 3000, clamped 1..10000 by the client). */
  jevTimeoutMs?: number
  /**
   * Jev request scope for turn-budget accounting (NOT the memory visibility
   * scope above). When the configured budget has perTurnCalls and no
   * operation scope is supplied, the rerank is fail-safed off rather than
   * burning a session-global constant scope.
   */
  jevScope?: string
  /** Jev request session identity (defaults to the memory sessionID above). */
  jevSessionID?: string
}

export interface RetrieveHit {
  entry: MemoryEntry
  rank: number
  reasons: string[]
}

export interface RetrieveResult {
  intent: QueryIntent
  reasoning: string[]
  hits: RetrieveHit[]
  totalHits: number
  /** True when the classifier decided memory isn't worth hitting. */
  skipped: boolean
}

const KIND_PRIORITY: Record<MemoryPayloadV1["kind"], number> = {
  decision: 1.0,
  architecture: 1.0,
  constraint: 0.95,
  convention: 0.9,
  preference: 0.9,
  warning: 0.9,
  failure: 0.85,
  pattern: 0.8,
  ownership: 0.7,
  identity: 0.7,
  environment: 0.7,
  observation: 0.4,
  summary: 0.3,
  todo: 0.35,
}

const SOURCE_AUTHORITY: Record<MemoryPayloadV1["source"]["type"], number> = {
  user: 1.0,
  agent: 0.7,
  system: 0.5,
  import: 0.4,
}

const CONFIDENCE_TO_RANK: Record<MemoryPayloadV1["confidence"], number> = {
  low: 0.2,
  medium: 0.6,
  high: 1.0,
}

/** Per-row deterministic score. Higher = better. Range ≈ [-1, 1]. */
export interface RankSignals {
  kind: number
  source: number
  confidence: number
  scopeMatch: number
  recency: number
}

export const computeRankSignals = (entry: MemoryEntry, now: number, scope: "global" | "session"): RankSignals => {
  const payload = unwrapMemoryValue(entry.value, entry.key)
  const kind = KIND_PRIORITY[payload.kind] ?? 0.4
  const source = SOURCE_AUTHORITY[payload.source.type] ?? 0.5
  const confidence = CONFIDENCE_TO_RANK[payload.confidence] ?? 0.4
  const scopeMatch = entry.scope === scope ? 0.15 : 0
  // recency: 0..0.2 over the last 30 days, exponential falloff.
  const ageMs = Math.max(0, now - entry.updatedAt)
  const recency = Math.max(0, 0.2 - 0.2 * (ageMs / (30 * 86_400_000)))
  return { kind, source, confidence, scopeMatch, recency }
}

const rankTotal = (s: RankSignals): number =>
  s.kind * 0.35 + s.source * 0.2 + s.confidence * 0.2 + s.scopeMatch + s.recency

const ago = (now: number, entry: MemoryEntry): string => {
  const ms = Math.max(0, now - entry.updatedAt)
  const days = Math.floor(ms / 86_400_000)
  if (days < 1) return "today"
  if (days < 30) return `${days}d`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Banyan/MemoryRetrieval") {}

export interface Interface {
  readonly classify: (input: ClassifyQueryInput) => Effect.Effect<ClassifyQueryResult, never, never>
  readonly retrieve: (input: RetrieveInput) => Effect.Effect<RetrieveResult, never, never>
}

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const layer: Layer.Layer<Service, never, MemoryRepo.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (!banyancodeEnabled()) {
      return Service.of({
        classify: (input) => Effect.succeed(classifyQuery(input)),
        retrieve: (input) =>
          Effect.succeed({
            intent: input.intentOverride ?? "code-centric",
            reasoning: ["banyancode disabled"],
            hits: [],
            totalHits: 0,
            skipped: true,
          }),
      })
    }

    const repo = yield* MemoryRepo.Service
    // Capture the optional config service at layer-build time. A call-time
    // `serviceOption` would always miss: by the time `retrieve()` runs the
    // outer `Effect.provide(...)` chain has been consumed and the fiber
    // context is empty, so the Jev gate would stay off even with a configured
    // layer. Capturing the service reference here keeps fresh `get()` reads
    // per call while working with the existing provide chains.
    const configServiceOpt = yield* Effect.serviceOption(BanyanConfigService.Service)

    const classify: Interface["classify"] = (input) =>
      Effect.succeed(classifyQuery(input))

    // Opt-in Jev rerank ("context-rerank") over the lexical order above.
    // Gating: Jev.feature(config, env, "context-rerank") with the ambient
    // BanyanConfigService when present; absent service, missing key, or an
    // explicit global disable returns the lexical hits untouched.
    // Safety: scope/session filtering already happened in searchRanked and is
    // never re-applied here; all candidates are preserved (no deletion or
    // promotion); protected (pinned/critical) entries keep their exact slots
    // and only the remaining slots are reordered by Jev scores; any
    // uncertainty or failure keeps the original lexical order.
    const maybeJevRerank = (
      query: string,
      scored: RetrieveHit[],
      input: RetrieveInput,
    ): Effect.Effect<{ hits: RetrieveHit[]; note?: string }, never, never> =>
      Effect.gen(function* () {
        const config: Jev.Config = Option.isSome(configServiceOpt) ? yield* configServiceOpt.value.get() : {}
        const env = input.env ?? process.env
        if (!Jev.feature(config, env, JevMemory.FEATURE)) return { hits: scored }
        // Turn-budget fail-safe: without a caller-supplied operation scope a
        // configured perTurnCalls budget cannot be enforced per turn, so keep
        // lexical order instead of charging a session-global constant scope.
        if (input.jevScope === undefined && config.banyancode_jev_budget?.perTurnCalls !== undefined)
          return { hits: scored, note: "jev-rerank-skipped:no-scope" }
        const free = scored.flatMap((hit, index) => (JevMemory.isProtected(hit.entry) ? [] : [{ hit, index }]))
        if (free.length === 0) return { hits: scored, note: "jev-rerank:all-pinned-preserved" }
        const shortlist = free.slice(0, JevMemory.MAX_SHORTLIST)
        const tail = free.slice(JevMemory.MAX_SHORTLIST)
        const timeoutMs = input.jevTimeoutMs ?? JevMemory.REQUEST_TIMEOUT_MS
        // One controller for the whole shortlist: the finalizer below aborts
        // in-flight physical Jev requests on deadline/interrupt so no paid
        // background request keeps running after we fall back to lexical.
        const controller = new AbortController()
        const scores = yield* Effect.forEach(
          shortlist,
          (slot) =>
            Effect.promise(() =>
              JevMemory.scoreCandidate({
                query,
                entry: slot.hit.entry,
                config,
                env,
                fetch: input.fetch,
                sessionID: input.jevSessionID ?? input.sessionID,
                scope: input.jevScope ?? JevMemory.DEFAULT_REQUEST_SCOPE,
                timeoutMs,
                signal: controller.signal,
              }),
            ),
          { concurrency: JevMemory.MAX_INFLIGHT },
        ).pipe(
          Effect.timeout(Duration.millis(JevMemory.RERANK_DEADLINE_MS)),
          Effect.option,
          Effect.catchCause(() => Effect.succeed(Option.none())),
          Effect.ensuring(Effect.sync(() => controller.abort())),
        )
        if (Option.isNone(scores)) return { hits: scored, note: "jev-rerank-skipped:deadline" }
        const ranked = shortlist
          .map((slot, k) => ({ slot, score: scores.value[k] }))
          .flatMap((part) => (part.score === undefined ? [] : [{ slot: part.slot, score: part.score }]))
        if (ranked.length !== shortlist.length) return { hits: scored, note: "jev-rerank-skipped:uncertain" }
        ranked.sort((a, b) => b.score - a.score || a.slot.index - b.slot.index)
        const ordered = [...ranked.map((part) => part.slot), ...tail]
        const hits = scored.map((hit) => hit)
        ordered.forEach((slot, k) => {
          const source = slot.hit
          hits[free[k].index] =
            k < ranked.length
              ? { ...source, reasons: [...source.reasons, `jev=${ranked[k].score.toFixed(2)}`] }
              : source
        })
        return { hits, note: `jev-rerank:${ranked.length}-scored` }
      }).pipe(Effect.catchCause(() => Effect.succeed({ hits: scored })))

    const retrieve: Interface["retrieve"] = (input) =>
      Effect.gen(function* () {
        const classification = classifyQuery({ query: input.query })
        const intent = input.intentOverride ?? classification.intent
        if (intent === "code-centric") {
          return {
            intent,
            reasoning: [...classification.reasons, "code-centric: prefer codegraph over memory"],
            hits: [],
            totalHits: 0,
            skipped: true,
          }
        }

        const limit = Math.max(1, Math.min(input.limit ?? 12, 50))
        const ranked = yield* repo.searchRanked({
          query: input.query,
          limit,
          scope: input.scope,
          sessionID: input.sessionID,
          status: input.status ?? "active",
        })

        const now = Date.now()
        const scored = ranked.entries.map((entry) => {
          const signals = computeRankSignals(entry, now, input.scope ?? "global")
          const rank = rankTotal(signals)
          const reasons = [
            `kind=${signals.kind.toFixed(2)}`,
            `source=${signals.source.toFixed(2)}`,
            `confidence=${signals.confidence.toFixed(2)}`,
            signals.scopeMatch > 0 ? "scope-match" : "",
            signals.recency > 0 ? `recent(${ago(now, entry)})` : "",
          ].filter(Boolean)
          return { entry, rank, reasons }
        })

        scored.sort((a, b) => b.rank - a.rank)

        const rerank = yield* maybeJevRerank(input.query, scored, input)

        return {
          intent,
          reasoning: rerank.note ? [...classification.reasons, rerank.note] : classification.reasons,
          hits: rerank.hits,
          totalHits: ranked.totalHits,
          skipped: false,
        }
      })

    return Service.of({ classify, retrieve })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, never> = layer.pipe(
  Layer.provide(MemoryRepo.defaultLayer),
)

export type { MemoryPayloadV1 }

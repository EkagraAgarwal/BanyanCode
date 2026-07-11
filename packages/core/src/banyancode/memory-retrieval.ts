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
 *
 * No embeddings, no LLMs. The signals are intrinsic.
 */

import { Context, Effect, Layer } from "effect"
import type { MemoryPayloadV1 } from "./memory-payload"
import type { MemoryEntry } from "./types"
import { MemoryRepo } from "./memory-repo"
import { unwrapMemoryValue } from "./memory-payload"

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

    const classify: Interface["classify"] = (input) =>
      Effect.succeed(classifyQuery(input))

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

        return {
          intent,
          reasoning: classification.reasons,
          hits: scored,
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

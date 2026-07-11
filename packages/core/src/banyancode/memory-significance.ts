/**
 * BanyanCode Memory Significance Scorer (Phase 2).
 *
 * Deterministic scoring function over a `MemoryPayloadV1` that decides whether
 * a candidate observation is durable enough to enter memory and how
 * important it is. No embeddings, no LLM — the score is derived from
 * intrinsic signals (kind, body length, source type, confidence,
 * importance, repetition in tag namespace).
 *
 * Used by the extractor gate (Phase 2) and downstream the candidate
 * lifecycle (Phase 1b). Higher score → more likely to be promoted from
 * `pending` to `active`.
 *
 * Score components (all `[0, 1]`):
 *
 * - kindBoost         (0..1): kinds that are inherently durable (decision,
 *                         architecture, constraint, convention, preference,
 *                         warning, failure) score higher than transient ones
 *                         (observation, summary, todo).
 * - sourceBoost       (0..1): user-confirmed > agent > system > import.
 * - confidenceBoost   (0..0.4): low < medium < high (linear within band).
 * - importanceBoost   (0..0.2): low < medium < high (linear within band).
 * - specificityBoost  (0..0.2): longer, more specific bodies (>180 chars)
 *                         score higher. Trims trailing whitespace-only bodies.
 * - repeatBoost       (0..0.2): same `kind` + overlapping tags in scope
 *                         lifts the score (signal of a repeated rule).
 *
 * Final score ∈ [0, 10].
 */

import type { MemoryPayloadV1 } from "./memory-payload"

export type KeepDecision = "keep" | "merge" | "summarize" | "discard"

const KIND_BOOST: Record<MemoryPayloadV1["kind"], number> = {
  preference: 0.95,
  identity: 0.95,
  convention: 0.9,
  decision: 0.9,
  architecture: 0.95,
  pattern: 0.85,
  warning: 0.9,
  failure: 0.85,
  constraint: 0.9,
  ownership: 0.8,
  environment: 0.85,
  observation: 0.4,
  summary: 0.3,
  todo: 0.35,
}

const SOURCE_BOOST: Record<MemoryPayloadV1["source"]["type"], number> = {
  user: 1,
  agent: 0.7,
  system: 0.5,
  import: 0.4,
}

const CONFIDENCE_TO_VALUE: Record<MemoryPayloadV1["confidence"], number> = {
  low: 0.1,
  medium: 0.25,
  high: 0.4,
}

const IMPORTANCE_TO_VALUE: Record<MemoryPayloadV1["importance"], number> = {
  low: 0.05,
  medium: 0.1,
  high: 0.2,
}

const KIND_WEIGHT = 4.5
const SOURCE_WEIGHT = 1.5

const SPECIFICITY_FLOOR = 60
const SPECIFICITY_CEILING = 480

export const KEEP_THRESHOLD = 5.5
export const MERGE_THRESHOLD = 3.5

export interface SignificanceBreakdown {
  kind: number
  source: number
  confidence: number
  importance: number
  specificity: number
  repeat: number
  total: number
}

export const scoreKind = (payload: MemoryPayloadV1): number => KIND_BOOST[payload.kind] * KIND_WEIGHT

export const scoreSource = (payload: MemoryPayloadV1): number =>
  SOURCE_BOOST[payload.source.type] * SOURCE_WEIGHT

export const scoreConfidence = (payload: MemoryPayloadV1): number =>
  CONFIDENCE_TO_VALUE[payload.confidence]

export const scoreImportance = (payload: MemoryPayloadV1): number =>
  IMPORTANCE_TO_VALUE[payload.importance]

export const scoreSpecificity = (payload: MemoryPayloadV1): number => {
  const trimmed = payload.body.trim()
  if (trimmed.length === 0) return 0
  if (trimmed.length <= SPECIFICITY_FLOOR) {
    return 0.05 * (trimmed.length / SPECIFICITY_FLOOR)
  }
  if (trimmed.length >= SPECIFICITY_CEILING) return 0.2
  return (
    0.05 +
    0.15 *
      ((trimmed.length - SPECIFICITY_FLOOR) /
        (SPECIFICITY_CEILING - SPECIFICITY_FLOOR))
  )
}

/**
 * Repeat boost: caller passes in the existing canonical entries in the same
 * scope so we can reward facts that confirm a known rule. Caller-side
 * filtering keeps this pure.
 */
export const scoreRepeat = (payload: MemoryPayloadV1, existing: ReadonlyArray<MemoryPayloadV1>): number => {
  if (existing.length === 0) return 0
  const tags = new Set((payload.tags ?? []).map((t) => t.toLowerCase()))
  const kindMatches = existing.filter((e) => e.kind === payload.kind)
  if (kindMatches.length === 0) return 0
  const overlappingTags = kindMatches.filter((e) =>
    (e.tags ?? []).some((t) => tags.has(t.toLowerCase())),
  ).length
  if (overlappingTags === 0) return 0.05
  return Math.min(0.2, 0.05 + overlappingTags * 0.05)
}

export interface ScoreInput {
  payload: MemoryPayloadV1
  existing?: ReadonlyArray<MemoryPayloadV1>
}

export const score = (input: ScoreInput): SignificanceBreakdown => ({
  kind: scoreKind(input.payload),
  source: scoreSource(input.payload),
  confidence: scoreConfidence(input.payload),
  importance: scoreImportance(input.payload),
  specificity: scoreSpecificity(input.payload),
  repeat: scoreRepeat(input.payload, input.existing ?? []),
  total: 0,
})

const TOTAL_KEYS: Array<keyof Omit<SignificanceBreakdown, "total">> = [
  "kind",
  "source",
  "confidence",
  "importance",
  "specificity",
  "repeat",
]

/**
 * Final score with total in [0, 10]. Use this when you want a single number.
 */
export const totalScore = (input: ScoreInput): number => {
  const breakdown = score(input)
  let total = 0
  for (const k of TOTAL_KEYS) total += breakdown[k]
  return Number(total.toFixed(3))
}

/**
 * Decide whether the candidate should be kept, merged into an existing
 * memory, summarized, or discarded. Pure / deterministic.
 */
export const decide = (input: ScoreInput): KeepDecision => {
  const breakdown = score(input)
  const total = TOTAL_KEYS.reduce((sum, k) => sum + breakdown[k], 0)
  if (total >= KEEP_THRESHOLD) return "keep"
  if (total >= MERGE_THRESHOLD) {
    const existing = input.existing ?? []
    return existing.length > 0 ? "merge" : "summarize"
  }
  const trimmedLength = input.payload.body.trim().length
  if (trimmedLength > SPECIFICITY_CEILING) return "summarize"
  return "discard"
}

/**
 * Lowercase, trim, collapse whitespace for body/title comparison so two
 * near-identical payloads fingerprint the same.
 */
export const normalizeForDedupe = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()

/**
 * Canonicalized key suggestion: `kind:slug-of-title`. Two payloads with the
 * same kind and the same normalized title should hash to the same key, which
 * makes ad-hoc dedupe by `key` work without an explicit fingerprint lookup.
 */
export const suggestKey = (payload: MemoryPayloadV1): string => {
  const slug = normalizeForDedupe(payload.title)
    .replace(/[^a-z0-9_:.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96)
  return `${payload.kind}:${slug || "untitled"}`
}

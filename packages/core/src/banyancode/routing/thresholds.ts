/**
 * Confidence policy constants and banding (spec §24):
 *
 *   >= 0.90  high-confidence semantic route   -> "intelligence"
 *   0.70-0.90 hybrid or validation-heavy      -> "hybrid"
 *   < 0.70   prefer direct behavior           -> "direct"
 *
 * Thresholds are placeholders and must be calibrated against a benchmark
 * corpus (spec §24: "Thresholds are placeholders and must be calibrated").
 */
import type { RouteVerdict } from "./types"

export const HIGH_CONFIDENCE = 0.9
export const MID_CONFIDENCE = 0.7

/**
 * Map a confidence value to a route using the §24 banding. `verdict` is the
 * router's suggested route: a `direct` suggestion is never upgraded by
 * confidence (exactness must win, §138), and a low-confidence semantic
 * suggestion falls back to direct (safe fallback policy, §25).
 */
export function routeForConfidence(confidence: number, verdict: RouteVerdict): RouteVerdict {
  if (verdict === "direct" || confidence < MID_CONFIDENCE) return "direct"
  if (confidence >= HIGH_CONFIDENCE) return "intelligence"
  return "hybrid"
}

/**
 * Pure staleness helper — thresholds match the existing edit-planner logic:
 * age > 1 day = med, age > 7 days = high, coverage < 0.5 = high regardless of age.
 * meta === undefined (never built) is always high.
 */
export interface StaleResult {
  stale: boolean
  severity?: "med" | "high"
  reason?: string
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS

export function isStale(
  meta: { graphBuiltAt: number; graphCoverage: number } | undefined,
  now = Date.now(),
): StaleResult {
  if (meta === undefined) {
    return { stale: true, severity: "high", reason: "graph has not been built" }
  }
  const ageMs = now - meta.graphBuiltAt
  if (meta.graphCoverage < 0.5) {
    return {
      stale: true,
      severity: "high",
      reason: `graph coverage is ${(meta.graphCoverage * 100).toFixed(0)}%; large parts of the codebase are unindexed`,
    }
  }
  if (ageMs > SEVEN_DAYS_MS) {
    const days = Math.floor(ageMs / ONE_DAY_MS)
    return {
      stale: true,
      severity: "high",
      reason: `graph is ${days} day${days !== 1 ? "s" : ""} old; consider rebuilding before editing`,
    }
  }
  if (ageMs > ONE_DAY_MS) {
    const days = Math.floor(ageMs / ONE_DAY_MS)
    return {
      stale: true,
      severity: "med",
      reason: `graph is ${days} day${days !== 1 ? "s" : ""} old; consider rebuilding before editing`,
    }
  }
  return { stale: false }
}

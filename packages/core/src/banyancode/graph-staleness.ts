/**
 * Pure staleness helper — thresholds match the existing edit-planner logic
 * and codegraph-readiness.ts:
 * age > 1 day = med, age > 7 days = high, coverage < 0.5 = high regardless of age.
 * meta === undefined (never built) is always high.
 */
import { Effect } from "effect"
import type { Interface as CodegraphRepoInterface } from "./codegraph-repo"

export interface StaleResult {
  stale: boolean
  severity?: "med" | "high"
  reason?: string
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS

export const STALENESS_AGE_MED_MS = ONE_DAY_MS
export const STALENESS_AGE_HIGH_MS = SEVEN_DAYS_MS
export const STALENESS_COVERAGE_HIGH = 0.5

export function isStale(
  meta: { graphBuiltAt: number; graphCoverage: number } | undefined,
  now = Date.now(),
): StaleResult {
  if (meta === undefined) {
    return { stale: true, severity: "high", reason: "graph has not been built" }
  }
  const ageMs = now - meta.graphBuiltAt
  if (meta.graphCoverage < STALENESS_COVERAGE_HIGH) {
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

/**
 * Per-result staleness (Phase 1): given a set of file IDs, batch-fetch the
 * file rows and count how many have an `mtimeMs` newer than their
 * `indexedAt` — i.e. the file changed on disk after (or during) the snapshot
 * the graph was built from. Returns `{ stale, staleFiles }` so tools can
 * surface both the boolean flag (for a `stale-graph` diagnostic) and the
 * count (for a `staleFiles` output field). Complements `isStale` (which is
 * meta-age/coverage only and cannot see a graph built minutes ago whose
 * files changed seconds ago).
 */
export const countStaleFilesFor = (
  repo: CodegraphRepoInterface,
  fileIDs: ReadonlyArray<string>,
): Effect.Effect<{ stale: boolean; staleFiles: number }, never, never> =>
  Effect.gen(function* () {
    if (fileIDs.length === 0) return { stale: false, staleFiles: 0 }
    const files = yield* repo.filesByIDs([...new Set(fileIDs)])
    let staleFiles = 0
    for (const f of files) {
      if ((f.mtimeMs ?? 0) > f.indexedAt) staleFiles++
    }
    return { stale: staleFiles > 0, staleFiles }
  })

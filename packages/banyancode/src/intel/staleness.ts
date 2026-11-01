import { Effect } from "effect"
import type { CodegraphPort } from "./codegraph-port.js"
import type { GraphMeta } from "./types.js"

/**
 * Staleness thresholds, ported from v1 `graph-staleness.ts`:
 * age > 1 day = med, age > 7 days = high, coverage < 0.5 = high.
 * A never-built graph (`meta === undefined`) is always high.
 */

export interface StaleResult {
  readonly stale: boolean
  readonly severity?: "med" | "high"
  readonly reason?: string
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS
const STALENESS_COVERAGE_HIGH = 0.5

export const isStale = (
  meta: Pick<GraphMeta, "graphBuiltAt" | "graphCoverage"> | undefined,
  now = Date.now(),
): StaleResult => {
  if (meta === undefined) return { stale: true, severity: "high", reason: "graph has not been built" }
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
 * Per-file drift: files whose `mtimeMs` is newer than their `indexedAt`
 * changed on disk after the snapshot the graph was built from.
 */
export const countStaleFilesFor = (
  port: CodegraphPort,
  fileIDs: ReadonlyArray<string>,
): Effect.Effect<{ stale: boolean; staleFiles: number }> =>
  Effect.gen(function* () {
    if (fileIDs.length === 0) return { stale: false, staleFiles: 0 }
    const files = yield* port.listFiles()
    const wanted = new Set(fileIDs)
    let staleFiles = 0
    for (const file of files) {
      if (!wanted.has(file.id)) continue
      if ((file.mtimeMs ?? 0) > file.indexedAt) staleFiles++
    }
    return { stale: staleFiles > 0, staleFiles }
  })

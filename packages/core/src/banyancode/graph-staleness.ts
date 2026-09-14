/**
 * Pure staleness helper — thresholds match the existing edit-planner logic
 * and codegraph-readiness.ts:
 * age > 1 day = med, age > 7 days = high, coverage < 0.5 = high regardless of age.
 * meta === undefined (never built) is always high.
 */
import { Effect } from "effect"
import { statSync, readFileSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
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

export interface DriftProbe {
  readonly discovered: number
  readonly changed: number
  readonly removed: number
  readonly cached: number
  readonly changedPaths: ReadonlyArray<string>
  readonly removedPaths: ReadonlyArray<string>
}

// Size+mtime probe with hash-only-on-diff: a row whose size and mtime both
// match the file on disk is a cache hit with no read; a row whose size
// differs is changed with no read; only size-same/mtime-different rows pay
// for a content read + hash compare, so timestamp-only touches stay cheap.
// Missing files are reported as removed (deleted-file detection). New files
// on disk are NOT discovered here — the watcher + periodic reconciliation
// walk owns discovery; this probe reconciles indexed rows only.
export const probeFileDrift = (
  repo: CodegraphRepoInterface,
): Effect.Effect<DriftProbe, never, never> =>
  Effect.gen(function* () {
    const files = yield* repo.listAllFiles().pipe(Effect.orElseSucceed(() => []))
    const changedPaths: string[] = []
    const removedPaths: string[] = []
    let changed = 0
    let removed = 0
    let cached = 0
    for (const f of files) {
      let stat: { size: number; mtimeMs: number } | undefined
      try {
        if (!existsSync(f.path)) {
          removed++
          removedPaths.push(f.path)
          continue
        }
        const s = statSync(f.path)
        stat = { size: s.size, mtimeMs: s.mtimeMs }
      } catch {
        removed++
        removedPaths.push(f.path)
        continue
      }
      if (f.sizeBytes !== undefined && stat.size !== f.sizeBytes) {
        changed++
        changedPaths.push(f.path)
        continue
      }
      if (f.mtimeMs !== undefined && stat.mtimeMs === f.mtimeMs) {
        cached++
        continue
      }
      let content: string | undefined
      try {
        content = readFileSync(f.path, "utf8")
      } catch {
        removed++
        removedPaths.push(f.path)
        continue
      }
      const hash = createHash("sha256").update(content).digest("hex")
      if (hash === f.contentHash) cached++
      else {
        changed++
        changedPaths.push(f.path)
      }
    }
    return { discovered: 0, changed, removed, cached, changedPaths, removedPaths }
  })

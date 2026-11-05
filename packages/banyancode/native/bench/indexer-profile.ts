#!/usr/bin/env bun
/**
 * Profile the codegraph indexer over a real tree.
 *
 *   bun native/bench/indexer-profile.ts <root> <runs> [label] [-- env pairs]
 *
 * Each run opens a throwaway database (BANYANCODE_PROJECT_DB_DIR), forces a
 * full rebuild, and lets the indexer's BANYANCODE_INDEX_PROFILE report carry
 * the per-phase numbers. The database is deleted between runs so every run
 * parses every file (no warm content-hash cache).
 *
 * Configurations used for specs/banyancode/native-indexer.md:
 *   BANYANCODE_NATIVE_INDEXER=off BANYANCODE_INDEX_PERSIST_BATCH=1  before
 *   BANYANCODE_NATIVE_INDEXER=off                                   TS + batched writes
 *   (defaults)                                                      native + batched writes
 *
 * BANYANCODE_PROFILE_REBUILD=1 builds once to populate the database and reports
 * a second forced build over it, the path a user's "rebuild" takes.
 *
 * Event-loop stalls are sampled in this process, which is the same thread the
 * indexer runs on, so they are what a client of the host would feel. A 2 ms timer
 * records every gap; a stall is a gap over 100 ms.
 *
 * Prints one JSON line per run plus a median summary.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Storage } from "../../src/storage/index.js"
import { make as makeRepo } from "../../src/codegraph/codegraph-repo.js"
import { make as makeIndexer } from "../../src/codegraph/codegraph-indexer.js"

const root = process.argv[2]
if (!root) throw new Error("usage: bun native/bench/indexer-profile.ts <root> <runs> [label]")
const runs = Number(process.argv[3] ?? "3")
const label = process.argv[4] ?? "run"

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

const results: Array<Record<string, number | string>> = []

for (let run = 0; run < runs; run++) {
  const dbDir = await mkdtemp(join(tmpdir(), "banyan-profile-db-"))
  const reportPath = join(dbDir, "profile.json")
  process.env.BANYANCODE_PROJECT_DB_DIR = dbDir
  process.env.BANYANCODE_INDEX_PROFILE = reportPath
  const started = { at: performance.now() }
  const stalls = { max: 0, over100: 0, over1000: 0, totalOver100: 0, last: performance.now() }
  const sampler = setInterval(() => {
    const now = performance.now()
    const gap = now - stalls.last
    stalls.last = now
    if (gap > stalls.max) stalls.max = gap
    if (gap > 100) {
      stalls.over100++
      stalls.totalOver100 += gap
    }
    if (gap > 1000) stalls.over1000++
  }, 2)
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* Storage.open({ projectRoot: root, env: process.env })
          const repo = makeRepo(storage)
          const indexer = yield* makeIndexer(repo, storage)
          if (process.env.BANYANCODE_PROFILE_REBUILD === "1") {
            yield* indexer.index({ root, force: true })
            started.at = performance.now()
            Object.assign(stalls, { max: 0, over100: 0, over1000: 0, totalOver100: 0, last: performance.now() })
          }
          yield* indexer.index({ root, force: true })
        }),
      ),
    )
  } finally {
    clearInterval(sampler)
    delete process.env.BANYANCODE_INDEX_PROFILE
  }
  const wallMs = performance.now() - started.at
  const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>
  const native = report.nativeTimings as
    | { walkMs: number; readMs: number; hashMs: number; parseMs: number; totalMs: number }
    | undefined
  const derived = (report.derived ?? {}) as Record<string, number>
  const row: Record<string, number | string> = {
    label,
    run: run + 1,
    backend: String(report.backend ?? "?"),
    wallMs: Math.round(wallMs),
    stallMaxMs: Math.round(stalls.max),
    stallsOver100: stalls.over100,
    stallsOver1000: stalls.over1000,
    stallTotalOver100Ms: Math.round(stalls.totalOver100),
    walkMs: Math.round(Number(report.walkMs ?? 0)),
    readMs: Math.round(Number(report.readMs ?? 0)),
    parseMs: Math.round(Number(report.parseMs ?? 0)),
    sqliteWriteMs: Math.round(Number(report.sqliteWriteMs ?? 0)),
    edgeResolveMs: Math.round(Number(report.edgeResolveMs ?? 0)),
    ...Object.fromEntries(Object.entries(derived).map(([key, value]) => [`derived.${key}`, Math.round(value)])),
    checkpointMs: Math.round(Number(report.checkpointMs ?? 0)),
    pruneMs: Math.round(Number(report.pruneMs ?? 0)),
    bumpMs: Math.round(Number(report.bumpMs ?? 0)),
    peakRssMb: Math.round(Number(report.peakRssBytes ?? 0) / 1048576),
    nativeReadMs: Math.round(native?.readMs ?? 0),
    nativeParseMs: Math.round(native?.parseMs ?? 0),
    nativeTotalMs: Math.round(native?.totalMs ?? 0),
    files: Number(report.files ?? 0),
    filesIndexed: Number(report.filesIndexed ?? 0),
  }
  results.push(row)
  console.log(JSON.stringify(row))
  await rm(dbDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

const fields = [
  "wallMs",
  "stallMaxMs",
  "stallsOver100",
  "stallsOver1000",
  "stallTotalOver100Ms",
  "walkMs",
  "readMs",
  "parseMs",
  "sqliteWriteMs",
  "edgeResolveMs",
  "checkpointMs",
  "pruneMs",
  "bumpMs",
  "peakRssMb",
  "nativeReadMs",
  "nativeParseMs",
  "nativeTotalMs",
] as const
const summary: Record<string, number> = {}
const derivedFields = Object.keys(results[0] ?? {}).filter((key) => key.startsWith("derived."))
for (const field of [...fields, ...derivedFields]) summary[field] = median(results.map((row) => Number(row[field] ?? 0)))
console.log(`median ${label} ${JSON.stringify(summary)}`)

/**
 * Regression tests for the agent freeze introduced after v26.08.15.
 *
 * The 26.08.16 codegraph derived pass (binding-aware graph derivation) was
 * a tight CPU-bound loop with no yield points and no cancellation checks.
 * On large repos it starved the single JS event loop: the session/TUI could
 * not render, Esc could not stop generation, and Ctrl+C could not exit.
 *
 * These tests pin the fixed behavior:
 *  1. `indexer.cancel()` during the derived pass terminates the index fiber
 *     promptly (cooperative per-batch checks).
 *  2. The event loop stays responsive (heartbeat) while a full index runs to
 *     completion, so the session/TUI keep rendering.
 *
 * Benchmark methodology: run this file against current `main` and against
 * `v26.08.15` in a git worktree and compare the printed `cancel->join` and
 * `max-gap` numbers. The baseline (v26.08.15) had a cheaper heuristic-only
 * derived pass; the regressed 26.08.16 builds had no yields at all.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Ref } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { CodegraphIndexer, defaultLayer as codegraphIndexerDefaultLayer } from "../../src/banyancode/codegraph-indexer"
import { tmpdir } from "../fixture/tmpdir"
import * as fs from "node:fs/promises"
import * as path from "node:path"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(
  codegraphIndexerDefaultLayer,
  CodegraphRepo.defaultLayer,
).pipe(Layer.provide(FSUtil.defaultLayer))

// Dense exported functions behind a deep barrel chain exercise the expensive
// binding-aware path without needing a huge number of filesystem entries.
const REPO_SIZE = 400
const FUNCTIONS_PER_FILE = 10
const BARREL_DEPTH = 24
const TOTAL_FILE_COUNT = REPO_SIZE + BARREL_DEPTH + 1

async function createSyntheticRepo(root: string, fileCount: number): Promise<void> {
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(path.join(root, "barrels"), { recursive: true })
  await fs.writeFile(
    path.join(root, "barrels/leaf.ts"),
    "export class Target { static run(x: number): number { return x } }\n",
  )
  await Promise.all(
    Array.from({ length: BARREL_DEPTH }, (_, i) =>
      fs.writeFile(
        path.join(root, `barrels/b${i}.ts`),
        `export * from "./${i === BARREL_DEPTH - 1 ? "leaf" : `b${i + 1}`}"\n`,
      ),
    ),
  )
  const CHUNK = 200
  for (let start = 0; start < fileCount; start += CHUNK) {
    const end = Math.min(start + CHUNK, fileCount)
    await Promise.all(
      Array.from({ length: end - start }, async (_, k) => {
        const i = start + k
        const functions = Array.from(
          { length: FUNCTIONS_PER_FILE },
          (_, j) => `export function fn${i}_${j}(x: number): number { return NS.Target.run(x) + ${i + j} }`,
        )
        await fs.writeFile(
          path.join(root, `f${i}.ts`),
          `import * as NS from "./barrels/b0"\n${functions.join("\n")}\n`,
        )
      }),
    )
  }
}

describe("codegraph derived-pass responsiveness (26.08.16 freeze regression)", () => {
  test("cancel during the derived pass terminates the index fiber promptly", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const workDir = path.join(tmp.path, "repo")
    await createSyntheticRepo(workDir, REPO_SIZE)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const indexer = yield* CodegraphIndexer.Service

        let lastDone = 0
        let lastTotal = 0
        let progressEvents = 0
        const done = yield* Ref.make(false)
        const fiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const r = yield* indexer.index({
              root: workDir,
              force: true,
              onProgress: ({ done: d, total }) => {
                lastDone = d
                lastTotal = total
                progressEvents++
                return Effect.void
              },
            })
            yield* Ref.set(done, true)
            return r
          }),
        )

        // Wait for the parse phase to finish. The derived pass starts right
        // after the last progress event, so canceling immediately after
        // `done === total` lands mid-pass. An idle-based fallback covers
        // versions whose progress semantics don't drive done to total.
        let lastProgressCount = 0
        let lastProgressAt = 0
        let passStarted = false
        for (let i = 0; i < 2400; i++) {
          yield* Effect.sleep(50)
          if (progressEvents > lastProgressCount) {
            lastProgressCount = progressEvents
            lastProgressAt = Date.now()
          }
          const parseReachedTotal = lastTotal > 0 && lastDone >= lastTotal
          const idleLongEnough = progressEvents > 0 && Date.now() - lastProgressAt >= 100
          if (parseReachedTotal || idleLongEnough) {
            passStarted = true
            break
          }
          if (yield* Ref.get(done)) break
        }

        expect(progressEvents).toBeGreaterThan(0)

        const alreadyFinished = yield* Ref.get(done)
        if (alreadyFinished) {
          // The whole index (parse + derived pass) finished inside the 300ms
          // idle window — the pass was too fast to cancel mid-flight. That is
          // itself a responsiveness data point; nothing left to cancel.
          console.log(`\n=== Derived-pass cancel responsiveness ===`)
          console.log(`repo files : ${TOTAL_FILE_COUNT}`)
          console.log(`progress   : ${progressEvents} events, parse ${lastDone}/${lastTotal}`)
          console.log(`note       : index completed before cancel (fast pass)`)
          console.log(`===========================================\n`)
          return { cancelLatencyMs: 0, ok: true }
        }

        expect(passStarted).toBe(true)

        // Cancel once the derived pass is under way. Per-batch cooperative
        // checks must wind the fiber down promptly.
        const cancelStart = Date.now()
        yield* indexer.cancel()
        const join = yield* Fiber.join(fiber).pipe(
          Effect.map((r) => ({ ok: true as const, value: r })),
          Effect.catchCause((cause) => Effect.succeed({ ok: false as const, cause })),
        )
        const cancelLatencyMs = Date.now() - cancelStart

        console.log(`\n=== Derived-pass cancel responsiveness ===`)
        console.log(`repo files : ${TOTAL_FILE_COUNT}`)
        console.log(`progress   : ${progressEvents} events, parse ${lastDone}/${lastTotal}`)
        console.log(`cancel->join: ${cancelLatencyMs}ms`)
        console.log(`outcome    : ${join.ok ? `completed (${JSON.stringify((join.value as { indexed: number }).indexed)} indexed)` : `failed`}`)
        console.log(`===========================================\n`)

        return { cancelLatencyMs, ok: join.ok }
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(result.ok).toBe(true)
    // Cooperative per-batch cancellation must wind the fiber down well under
    // this bound. Before the fix, cancel() had no effect during the pass and
    // the fiber ran the whole derived pass (seconds to minutes on big repos).
    expect(result.cancelLatencyMs).toBeLessThan(5000)
  }, 180_000)

  test("event loop stays responsive during a full index (heartbeat benchmark)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const workDir = path.join(tmp.path, "repo")
    await createSyntheticRepo(workDir, REPO_SIZE)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const indexer = yield* CodegraphIndexer.Service

        let lastTick = Date.now()
        let maxGap = 0
        let tickCount = 0
        const heartbeat = yield* Effect.forkScoped(
          Effect.gen(function* () {
            for (;;) {
              yield* Effect.sleep(50)
              const now = Date.now()
              const gap = now - lastTick
              lastTick = now
              if (gap > maxGap) maxGap = gap
              tickCount++
            }
          }),
        )

        const startedAt = Date.now()
        const indexResult = yield* indexer.index({ root: workDir, force: true })
        const totalMs = Date.now() - startedAt
        yield* Fiber.interrupt(heartbeat)

        console.log(`\n=== Event-loop heartbeat during full index ===`)
        console.log(`repo files : ${TOTAL_FILE_COUNT}`)
        console.log(`indexed    : ${indexResult.indexed} in ${totalMs}ms`)
        console.log(`heartbeats : ${tickCount} ticks (50ms cadence)`)
        console.log(`max gap    : ${maxGap}ms (largest event-loop stall)`)
        console.log(`==============================================\n`)

        return { maxGap, indexed: indexResult.indexed }
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(result.indexed).toBe(TOTAL_FILE_COUNT)
    // Any gap over ~2s means the loop starved for a full render/input cycle.
    // The fix yields every 500 nodes, so real stalls are sub-100ms; 2s is a
    // generous CI-safe bound that the pre-fix CPU-bound pass would blow past.
    expect(result.maxGap).toBeLessThan(2000)
  }, 180_000)
})

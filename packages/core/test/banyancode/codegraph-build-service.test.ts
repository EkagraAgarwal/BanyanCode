import { describe, expect, test } from "bun:test"
import { Cause, Effect, Fiber, Layer, Queue } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import { CodegraphBuildService, layer } from "../../src/banyancode/codegraph-build-service"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"

// Set BANYANCODE_ENABLE for all tests
process.env.BANYANCODE_ENABLE = "1"

const makeMockIndexer = (options: {
  indexResult?: {
    indexed: number
    skipped: number
    scannedFiles: number
    eligibleFiles: number
    symbolsIndexed?: number
    skippedByReason?: {
      gitignored: number
      banyanignored: number
      artifact: number
      tooLarge: number
      minified: number
      tooLargeParse: number
      cached: number
      readError: number
      parseFailure: number
    }
  }
  indexError?: CodegraphIndexer.CodegraphError
  progressUpdates?: { file: string; done: number; total: number }[]
  progressSleepMs?: number
}) => {
  return Layer.succeed(
    CodegraphIndexer.Service,
    CodegraphIndexer.Service.of({
      index: (input) => {
        return Effect.gen(function* () {
          for (const update of options.progressUpdates ?? []) {
            if (options.progressSleepMs) yield* Effect.sleep(options.progressSleepMs)
            if (input.onProgress) yield* input.onProgress(update)
          }
          if (options.indexError) return yield* Effect.fail(options.indexError)
          if (options.indexResult) {
            const emptyReasons = {
              gitignored: 0,
              banyanignored: 0,
              artifact: 0,
              tooLarge: 0,
              minified: 0,
              tooLargeParse: 0,
              cached: 0,
              readError: 0,
              parseFailure: 0,
            }
            return {
              ...options.indexResult,
              symbolsIndexed: options.indexResult.symbolsIndexed ?? 0,
              skippedByReason: options.indexResult.skippedByReason ?? emptyReasons,
              parseErrors: [],
            }
          }
          return {
            indexed: 0,
            skipped: 0,
            scannedFiles: 0,
            eligibleFiles: 0,
            symbolsIndexed: 0,
            skippedByReason: {
              gitignored: 0,
              banyanignored: 0,
              artifact: 0,
              tooLarge: 0,
              minified: 0,
              tooLargeParse: 0,
              cached: 0,
              readError: 0,
              parseFailure: 0,
            },
            parseErrors: [],
          }
        })
      },
      applyChanges: () => Effect.succeed({ indexed: 0, removed: 0, skipped: 0, parseErrors: [] }),
      indexFiles: () => Effect.succeed({ indexed: 0, skipped: 0, parseErrors: [] }),
      removeFiles: () => Effect.void,
      cancel: () => Effect.void,
    }),
  )
}

describe("CodegraphBuildService", () => {
  test("successful build transitions to completed with result", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockIndexer = makeMockIndexer({
      progressUpdates: [
        { file: "a.ts", done: 1, total: 2 },
        { file: "b.ts", done: 2, total: 2 },
      ],
      indexResult: { indexed: 5, skipped: 2, scannedFiles: 7, eligibleFiles: 7 },
    })

    const serviceLayer = layer.pipe(Layer.provide(mockIndexer), Layer.provide(EventV2.defaultLayer), Layer.provide(CodegraphRepo.defaultLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphBuildService.Service

        yield* service.start({ root: tmp.path, force: false })

        // Wait for the build to complete
        yield* Effect.sleep(100)

        const state = yield* service.status()
        expect(state.status).toBe("completed")
        expect(state.result?.indexed).toBe(5)
        expect(state.result?.skipped).toBe(2)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("failed build transitions to failed with error message", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockIndexer = makeMockIndexer({
      indexError: new CodegraphIndexer.CodegraphError({ message: "Index failed: parse error" }),
    })

    const serviceLayer = layer.pipe(Layer.provide(mockIndexer), Layer.provide(EventV2.defaultLayer), Layer.provide(CodegraphRepo.defaultLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphBuildService.Service

        yield* service.start({ root: tmp.path, force: false })

        // Wait for the build to fail
        yield* Effect.sleep(100)

        const state = yield* service.status()
        expect(state.status).toBe("failed")
        expect(state.error).toBe("Index failed: parse error")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("idle state starts as idle", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockIndexer = makeMockIndexer({})

    const serviceLayer = layer.pipe(Layer.provide(mockIndexer), Layer.provide(EventV2.defaultLayer), Layer.provide(CodegraphRepo.defaultLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphBuildService.Service
        const state = yield* service.status()
        expect(state.status).toBe("idle")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("build uses canonical db path derived from root, ignoring client dbPath", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockIndexer = makeMockIndexer({
      indexResult: { indexed: 5, skipped: 2, scannedFiles: 7, eligibleFiles: 7 },
    })

    const serviceLayer = layer.pipe(Layer.provide(mockIndexer), Layer.provide(EventV2.defaultLayer), Layer.provide(CodegraphRepo.defaultLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphBuildService.Service

        // The caller's dbPath is now a diagnostic marker, NOT the path
        // the build actually writes to. The canonical db path is derived
        // from the root via WorkspaceIdentity.identityForRoot.
        yield* service.start({ root: tmp.path, force: false, dbPath: "/custom/path/to/db.sqlite" })

        yield* Effect.sleep(100)

        const state = yield* service.status()
        expect(state.status).toBe("completed")
        // The dbPath returned to the client reflects the canonical workspace
        // location, not the stub — this is the bug the Phase 7 follow-up
        // fixed: old clients observed the value they passed; new clients
        // always see the truth.
        expect(state.dbPath).not.toBe("/custom/path/to/db.sqlite")
        expect(state.dbPath).toBeDefined()
        expect(state.banyanDir).toBeDefined()
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("successful build sets graphVersion and graphCoverage on state", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockIndexer = makeMockIndexer({
      indexResult: { indexed: 5, skipped: 2, scannedFiles: 7, eligibleFiles: 7 },
    })

    const serviceLayer = layer.pipe(
      Layer.provide(mockIndexer),
      Layer.provide(EventV2.defaultLayer),
      Layer.provideMerge(CodegraphRepo.defaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphBuildService.Service
        const repo = yield* CodegraphRepo.Service

        yield* service.start({ root: tmp.path, force: false })

        yield* Effect.sleep(100)

        // Phase 0: graphCoverage is derived from `codegraph_files` row count
        // over `eligibleFiles`. The mock writes no rows, so numerator is 0
        // and coverage is 0 even though the caller passed indexedFiles=5.
        // The test pins the success-side invariant (graphVersion bumps,
        // state is populated) and the new numerator contract.
        const state = yield* service.status()
        expect(state.status).toBe("completed")
        expect(state.graphVersion).toBe(1)
        expect(state.graphCoverage).toBe(0)

        const meta = yield* repo.getMeta()
        expect(meta?.graphVersion).toBe(1)
        expect(meta?.graphCoverage).toBe(0)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("failed build does NOT set graphVersion (success-only guard)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockIndexer = makeMockIndexer({
      indexError: new CodegraphIndexer.CodegraphError({ message: "parse failed" }),
    })

    const serviceLayer = layer.pipe(
      Layer.provide(mockIndexer),
      Layer.provide(EventV2.defaultLayer),
      Layer.provideMerge(CodegraphRepo.defaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphBuildService.Service
        const repo = yield* CodegraphRepo.Service

        yield* service.start({ root: tmp.path, force: false })
        yield* Effect.sleep(100)

        const state = yield* service.status()
        expect(state.status).toBe("failed")
        expect(state.graphVersion).toBeUndefined()
        expect(state.error).toBe("parse failed")

        // DB confirms: no meta row was written
        const meta = yield* repo.getMeta()
        expect(meta).toBeUndefined()
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("progress publications are throttled while the terminal state is always published", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    // 200 callbacks at a 5ms cadence flood the worker in ~1s. The build
    // service must coalesce these into ~1 publication per 100ms so the TUI
    // never sees a `banyancode.codegraph.build` event per file, while still
    // (a) keeping `status()` fresh on every callback and (b) always
    // publishing the terminal "completed" state.
    const updateCount = 200
    const updates = Array.from({ length: updateCount }, (_, i) => ({
      file: `f${i}.ts`,
      done: i + 1,
      total: updateCount,
    }))
    const mockIndexer = makeMockIndexer({
      progressUpdates: updates,
      progressSleepMs: 5,
      indexResult: { indexed: updateCount, skipped: 0, scannedFiles: updateCount, eligibleFiles: updateCount },
    })

    const serviceLayer = layer.pipe(
      Layer.provide(mockIndexer),
      Layer.provide(EventV2.defaultLayer),
      Layer.provide(CodegraphRepo.defaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphBuildService.Service

        let progressPublished = 0
        let lastRunningAt = 0
        let terminal: CodegraphBuildService.State | undefined
        const drain = yield* Effect.forkScoped(
          Effect.gen(function* () {
            for (;;) {
              const ev = yield* Queue.take(service.events())
              if (ev.properties.status === "running") {
                progressPublished++
                lastRunningAt = Date.now()
              }
              terminal = ev.properties
              if (ev.properties.status === "completed" || ev.properties.status === "failed" || ev.properties.status === "cancelled") return
            }
          }),
        )

        yield* service.start({ root: tmp.path, force: false })
        yield* Fiber.join(drain).pipe(Effect.timeout("10 seconds"))

        const state = yield* service.status()

        console.log(`\n=== Progress publication throttling ===`)
        console.log(`callbacks   : ${updateCount} progress updates over ~1s`)
        console.log(`published   : ${progressPublished} running events`)
        console.log(`lastRunning : ${lastRunningAt > 0 ? `${Date.now() - lastRunningAt}ms ago` : "n/a"}`)
        console.log(`terminal    : ${terminal?.status}`)
        console.log(`state.done  : ${state.done}/${state.total}`)
        console.log(`=======================================\n`)

        // The flood must coalesce: 200 callbacks at a 100ms publish cadence
        // yield ~10-15 running events on a normal machine. 50 is a wide CI-safe
        // ceiling that still fails loudly if someone removes the throttle and
        // every callback becomes a published event (~201).
        expect(progressPublished).toBeLessThanOrEqual(50)
        expect(progressPublished).toBeGreaterThan(0)
        // Terminal state bypasses the throttle — the TUI's progress widget
        // must always observe the completed transition.
        expect(terminal?.status).toBe("completed")
        // `status()` reflects the freshest callback even while publishing is
        // throttled.
        expect(state.status).toBe("completed")
        expect(state.done).toBe(updateCount)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("build result contains all 9 skippedByReason buckets for toModelOutput fidelity", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockIndexer = makeMockIndexer({
      progressUpdates: [{ file: "a.ts", done: 1, total: 1 }],
      indexResult: {
        indexed: 5,
        skipped: 10,
        scannedFiles: 15,
        eligibleFiles: 12,
        symbolsIndexed: 20,
        skippedByReason: {
          gitignored: 2,
          banyanignored: 1,
          artifact: 1,
          tooLarge: 2,
          minified: 1,
          tooLargeParse: 1,
          cached: 1,
          readError: 1,
          parseFailure: 0,
        },
      },
    })

    const serviceLayer = layer.pipe(Layer.provide(mockIndexer), Layer.provide(EventV2.defaultLayer), Layer.provide(CodegraphRepo.defaultLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphBuildService.Service

        yield* service.start({ root: tmp.path, force: false })
        yield* Effect.sleep(100)

        const state = yield* service.status()
        expect(state.status).toBe("completed")

        const r = state.result?.skippedByReason
        expect(r).toBeDefined()
        expect(r?.gitignored).toBe(2)
        expect(r?.banyanignored).toBe(1)
        expect(r?.artifact).toBe(1)
        expect(r?.tooLarge).toBe(2)
        expect(r?.minified).toBe(1)
        expect(r?.tooLargeParse).toBe(1)
        expect(r?.cached).toBe(1)
        expect(r?.readError).toBe(1)
        expect(r?.parseFailure).toBe(0)

        expect(state.parseErrors).toBeDefined()
        expect(Array.isArray(state.parseErrors)).toBe(true)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

import { describe, expect, test } from "bun:test"
import { Cause, Effect, Layer } from "effect"
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
}) => {
  return Layer.succeed(
    CodegraphIndexer.Service,
    CodegraphIndexer.Service.of({
      index: (input) => {
        return Effect.gen(function* () {
          for (const update of options.progressUpdates ?? []) {
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
      indexResult: { indexed: 5, skipped: 2, scannedFiles: 7 },
    })

    const serviceLayer = layer.pipe(Layer.provide(mockIndexer), Layer.provide(EventV2.defaultLayer), Layer.provide(CodegraphRepo.defaultLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphBuildService.Service

        yield* service.start({ root: "/test", force: false })

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

        yield* service.start({ root: "/test", force: false })

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

  test("successful build propagates dbPath to state", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockIndexer = makeMockIndexer({
      indexResult: { indexed: 5, skipped: 2, scannedFiles: 7 },
    })

    const serviceLayer = layer.pipe(Layer.provide(mockIndexer), Layer.provide(EventV2.defaultLayer), Layer.provide(CodegraphRepo.defaultLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphBuildService.Service

        yield* service.start({ root: "/test", force: false, dbPath: "/custom/path/to/db.sqlite" })

        yield* Effect.sleep(100)

        const state = yield* service.status()
        expect(state.status).toBe("completed")
        expect(state.dbPath).toBe("/custom/path/to/db.sqlite")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("successful build sets graphVersion and graphCoverage on state", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockIndexer = makeMockIndexer({
      indexResult: { indexed: 5, skipped: 2, scannedFiles: 7 },
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

        yield* service.start({ root: "/test", force: false })

        yield* Effect.sleep(100)

        const state = yield* service.status()
        expect(state.status).toBe("completed")
        expect(state.graphVersion).toBe(1)
        expect(state.graphCoverage).toBeCloseTo(5 / 7, 5)

        const meta = yield* repo.getMeta()
        expect(meta?.graphVersion).toBe(1)
        expect(meta?.graphCoverage).toBeCloseTo(5 / 7, 5)
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

        yield* service.start({ root: "/test", force: false })
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

        yield* service.start({ root: "/test", force: false })
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

import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import { Banyan } from "../../src/banyancode"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, layer as codegraphRepoLayer } from "../../src/banyancode/codegraph-repo"
import { CodegraphBuildService, layer as codegraphBuildServiceLayer } from "../../src/banyancode/codegraph-build-service"
import { PermissionV2 } from "../../src/permission"

process.env.BANYANCODE_ENABLE = "1"

describe("codegraph-worktree", () => {
  test("WorktreeContext thunk is invoked at tool-execute time (mirrors codegraph_build.resolve path)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "worktree.sqlite")

    const capturedRoot = { current: undefined as string | undefined }
    let thunkInvocations = 0

    const mockIndexer = Layer.succeed(
      CodegraphIndexer.Service,
      CodegraphIndexer.Service.of({
        index: (input) => {
          capturedRoot.current = input.root
          return Effect.succeed({
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
          })
        },
        indexFiles: () => Effect.succeed({ indexed: 0, skipped: 0, parseErrors: [] }),
        removeFiles: () => Effect.void,
        cancel: () => Effect.void,
      }),
    )

    const worktreeLayer = Layer.succeed(
      Banyan.WorktreeContext,
      () => {
        thunkInvocations++
        return Effect.succeed<string | undefined>("/tmp/somewhere")
      },
    )

    const mockPermission = Layer.succeed(
      PermissionV2.Service,
      {
        assert: () => Effect.void,
        ask: () => Effect.die("not used"),
        reply: () => Effect.die("not used"),
        get: () => Effect.succeed(undefined),
        forSession: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      } as unknown as PermissionV2.Interface,
    )

    const repoLayer = codegraphRepoLayer.pipe(Layer.provide(Database.layerFromPath(dbPath)))
    const buildServiceLayer = codegraphBuildServiceLayer.pipe(Layer.provide(mockIndexer), Layer.provide(repoLayer))

    const resolveAndStart = Effect.gen(function* () {
      const worktreeAccessor = yield* Banyan.WorktreeContext
      const worktreeOpt = yield* worktreeAccessor()
      const inputRoot: string | undefined = undefined
      const root = inputRoot ?? worktreeOpt ?? process.cwd()
      const service = yield* CodegraphBuildService.Service
      yield* service.start({ root, force: false })
      let status = yield* service.status()
      for (let i = 0; i < 20; i++) {
        if (status.status === "running") {
          yield* Effect.sleep("50 millis")
          status = yield* service.status()
        } else {
          break
        }
      }
    })

    await Effect.runPromise(
      resolveAndStart.pipe(
        Effect.provide(worktreeLayer),
        Effect.provide(buildServiceLayer),
        Effect.provide(repoLayer),
        Effect.provide(mockPermission),
        Effect.scoped,
      ),
    )

    expect(thunkInvocations).toBe(1)
    expect(capturedRoot.current).toBe("/tmp/somewhere")
    expect(capturedRoot.current).not.toBe(process.cwd())
  })

  test("WorktreeContext thunk returns undefined → falls back to process.cwd()", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "fallback.sqlite")

    const capturedRoot = { current: undefined as string | undefined }

    const mockIndexer = Layer.succeed(
      CodegraphIndexer.Service,
      CodegraphIndexer.Service.of({
        index: (input) => {
          capturedRoot.current = input.root
          return Effect.succeed({
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
          })
        },
        indexFiles: () => Effect.succeed({ indexed: 0, skipped: 0, parseErrors: [] }),
        removeFiles: () => Effect.void,
        cancel: () => Effect.void,
      }),
    )

    const worktreeLayer = Layer.succeed(
      Banyan.WorktreeContext,
      () => Effect.succeed<string | undefined>(undefined),
    )

    const repoLayer = codegraphRepoLayer.pipe(Layer.provide(Database.layerFromPath(dbPath)))
    const buildServiceLayer = codegraphBuildServiceLayer.pipe(Layer.provide(mockIndexer), Layer.provide(repoLayer))

    const resolveAndStart = Effect.gen(function* () {
      const worktreeAccessor = yield* Banyan.WorktreeContext
      const worktreeOpt = yield* worktreeAccessor()
      const inputRoot: string | undefined = undefined
      const root = inputRoot ?? worktreeOpt ?? process.cwd()
      const service = yield* CodegraphBuildService.Service
      yield* service.start({ root, force: false })
      let status = yield* service.status()
      for (let i = 0; i < 20; i++) {
        if (status.status === "running") {
          yield* Effect.sleep("50 millis")
          status = yield* service.status()
        } else {
          break
        }
      }
    })

    const fallback = process.cwd()

    await Effect.runPromise(
      resolveAndStart.pipe(
        Effect.provide(worktreeLayer),
        Effect.provide(buildServiceLayer),
        Effect.provide(repoLayer),
        Effect.scoped,
      ),
    )

    expect(capturedRoot.current).toBe(fallback)
  })

  test("input.root takes precedence over the WorktreeContext thunk", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "explicit.sqlite")

    const capturedRoot = { current: undefined as string | undefined }

    const mockIndexer = Layer.succeed(
      CodegraphIndexer.Service,
      CodegraphIndexer.Service.of({
        index: (input) => {
          capturedRoot.current = input.root
          return Effect.succeed({
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
          })
        },
        indexFiles: () => Effect.succeed({ indexed: 0, skipped: 0, parseErrors: [] }),
        removeFiles: () => Effect.void,
        cancel: () => Effect.void,
      }),
    )

    const worktreeLayer = Layer.succeed(
      Banyan.WorktreeContext,
      () => Effect.succeed<string | undefined>("/tmp/from-thunk"),
    )

    const repoLayer = codegraphRepoLayer.pipe(Layer.provide(Database.layerFromPath(dbPath)))
    const buildServiceLayer = codegraphBuildServiceLayer.pipe(Layer.provide(mockIndexer), Layer.provide(repoLayer))

    const resolveAndStart = Effect.gen(function* () {
      const worktreeAccessor = yield* Banyan.WorktreeContext
      const worktreeOpt = yield* worktreeAccessor()
      const inputRoot: string | undefined = "/tmp/explicit-input"
      const root = inputRoot ?? worktreeOpt ?? process.cwd()
      const service = yield* CodegraphBuildService.Service
      yield* service.start({ root, force: false })
      let status = yield* service.status()
      for (let i = 0; i < 20; i++) {
        if (status.status === "running") {
          yield* Effect.sleep("50 millis")
          status = yield* service.status()
        } else {
          break
        }
      }
    })

    await Effect.runPromise(
      resolveAndStart.pipe(
        Effect.provide(worktreeLayer),
        Effect.provide(buildServiceLayer),
        Effect.provide(repoLayer),
        Effect.scoped,
      ),
    )

    expect(capturedRoot.current).toBe("/tmp/explicit-input")
  })
})
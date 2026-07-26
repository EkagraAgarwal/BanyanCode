import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { CodegraphAutoUpdate } from "@opencode-ai/core/banyancode/codegraph-auto-update"
import { BanyanConfigService } from "@opencode-ai/core/banyancode/banyan-config"
import { CodegraphBuildService } from "@opencode-ai/core/banyancode/codegraph-build-service"
import { CodegraphIndexer } from "@opencode-ai/core/banyancode/codegraph-indexer"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const makeMockIndexer = (calls?: { index: Array<{ paths: string[] }>; remove: Array<{ paths: string[] }> }): Layer.Layer<CodegraphIndexer.Service> =>
  Layer.succeed(
    CodegraphIndexer.Service,
    CodegraphIndexer.Service.of({
      index: () =>
        Effect.succeed({
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
        }),
      applyChanges: () => Effect.succeed({ indexed: 0, removed: 0, skipped: 0, parseErrors: [] }),
      indexFiles: (input) =>
        Effect.sync(() => {
          calls?.index.push({ paths: input.paths })
          return { indexed: input.paths.length, skipped: 0, parseErrors: [] }
        }),
      removeFiles: (input) =>
        Effect.sync(() => {
          calls?.remove.push({ paths: input.paths })
        }),
      cancel: () => Effect.void,
    }),
  )

const makeBuildService = (starts: Array<{ root: string; excludePatterns?: readonly string[] }>, running = false): Layer.Layer<CodegraphBuildService.Service> =>
  Layer.succeed(
    CodegraphBuildService.Service,
    CodegraphBuildService.Service.of({
      status: () => Effect.succeed({ status: running ? "running" : "idle", done: 0, total: 0 } as CodegraphBuildService.State),
      start: (input) =>
        Effect.sync(() => {
          starts.push({ root: input.root, ...(input.excludePatterns ? { excludePatterns: input.excludePatterns } : {}) })
        }),
      cancel: () => Effect.void,
      forceKill: () => Effect.succeed({ ok: true, message: "noop" }),
      events: () => Effect.die("not used") as never,
    }),
  )

const makeRepo = (indexedRoot?: string): Layer.Layer<CodegraphRepo.Service> =>
  Layer.succeed(
    CodegraphRepo.Service,
    CodegraphRepo.Service.of({ getMeta: () => Effect.succeed(indexedRoot ? ({ indexedRoot } as never) : undefined) } as CodegraphRepo.Interface),
  )

const makeConfig = (config: {
  banyancode_codegraph_watch_debounce_ms?: number
  banyancode_codegraph_exclude_patterns?: readonly string[]
}): Layer.Layer<BanyanConfigService.Service> =>
  Layer.succeed(
    BanyanConfigService.Service,
    BanyanConfigService.Service.of({ get: () => Effect.succeed(config as never) } as unknown as BanyanConfigService.Interface),
  )

const testLayer = (input: {
  indexedRoot?: string
  calls?: { index: Array<{ paths: string[] }>; remove: Array<{ paths: string[] }> }
  starts?: Array<{ root: string; excludePatterns?: readonly string[] }>
  config?: { banyancode_codegraph_watch_debounce_ms?: number; banyancode_codegraph_exclude_patterns?: readonly string[] }
}) =>
  CodegraphAutoUpdate.layer.pipe(
    Layer.provideMerge(EventV2.defaultLayer),
    Layer.provideMerge(makeMockIndexer(input.calls)),
    Layer.provideMerge(makeRepo(input.indexedRoot)),
    Layer.provideMerge(makeBuildService(input.starts ?? [])),
    Layer.provideMerge(makeConfig(input.config ?? {})),
  )

describe("CodegraphAutoUpdate", () => {
  test("starts in idle status and supports pause/resume", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "auto.sqlite"))
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CodegraphAutoUpdate.Service
        expect((yield* svc.state()).status).toBe("idle")
        yield* svc.resume()
        expect((yield* svc.state()).pending).toBe(0)
        yield* svc.pause()
        expect((yield* svc.state()).status).toBe("paused")
      }).pipe(Effect.provide(testLayer({})), Effect.provide(dbLayer), Effect.scoped) as any,
    )
  })

  test("publishes a matching synthetic watcher event and enters draining", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "workspace")
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "auto.sqlite"))
    const calls = { index: [], remove: [] } as { index: Array<{ paths: string[] }>; remove: Array<{ paths: string[] }> }
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CodegraphAutoUpdate.Service
        const events = yield* EventV2.Service
        yield* events.publish(
          Watcher.Event.Updated,
          { file: path.join(root, "src", "foo.ts"), event: "change" },
          { location: { directory: root as never } },
        )
        yield* Effect.yieldNow
        const state = yield* svc.state()
        expect(state.status).toBe("draining")
        expect(state.pending).toBe(1)
        yield* Queue.take(svc.events())
        const event = yield* Queue.take(svc.events())
        expect(event.properties.pending).toBe(1)
      }).pipe(Effect.provide(testLayer({ indexedRoot: root, calls, config: { banyancode_codegraph_watch_debounce_ms: 100 } })), Effect.provide(dbLayer), Effect.scoped) as any,
    )
  })

  test("trailing debounce coalesces events arriving 100ms apart", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "workspace")
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "auto.sqlite"))
    const calls = { index: [], remove: [] } as { index: Array<{ paths: string[] }>; remove: Array<{ paths: string[] }> }
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const svc = yield* CodegraphAutoUpdate.Service
        for (const file of ["a.ts", "b.ts"]) {
          yield* events.publish(Watcher.Event.Updated, { file: path.join(root, file), event: "change" }, { location: { directory: root as never } })
          yield* Effect.sleep(100)
        }
        yield* Effect.sleep(250)
        expect(calls.index).toHaveLength(1)
        expect(calls.index[0].paths).toHaveLength(2)
        expect((yield* svc.state()).pending).toBe(0)
      }).pipe(Effect.provide(testLayer({ indexedRoot: root, calls, config: { banyancode_codegraph_watch_debounce_ms: 100 } })), Effect.provide(dbLayer), Effect.scoped) as any,
    )
  })

  test("delete grace turns unlink followed by add into one reindex", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "workspace")
    const file = path.join(root, "atomic.ts")
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "auto.sqlite"))
    const calls = { index: [], remove: [] } as { index: Array<{ paths: string[] }>; remove: Array<{ paths: string[] }> }
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        yield* events.publish(Watcher.Event.Updated, { file, event: "unlink" }, { location: { directory: root as never } })
        yield* Effect.sleep(120)
        yield* events.publish(Watcher.Event.Updated, { file, event: "add" }, { location: { directory: root as never } })
        yield* Effect.sleep(350)
        expect(calls.remove).toHaveLength(0)
        expect(calls.index).toHaveLength(1)
        expect(calls.index[0].paths).toEqual([file])
      }).pipe(Effect.provide(testLayer({ indexedRoot: root, calls, config: { banyancode_codegraph_watch_debounce_ms: 100 } })), Effect.provide(dbLayer), Effect.scoped) as any,
    )
  })

  test("triggers an initial build when indexedRoot is absent", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "foo", "bar.ts")
    const starts: Array<{ root: string; excludePatterns?: readonly string[] }> = []
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "auto.sqlite"))
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        yield* events.publish(Watcher.Event.Updated, { file, event: "add" }, { location: { directory: tmp.path as never } })
        yield* Effect.sleep(150)
        expect(starts).toHaveLength(1)
        expect(starts[0].root).toBe(path.join(tmp.path, "foo"))
      }).pipe(Effect.provide(testLayer({ starts, config: { banyancode_codegraph_watch_debounce_ms: 100 } })), Effect.provide(dbLayer), Effect.scoped) as any,
    )
  })
})

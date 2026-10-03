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
import fs from "node:fs"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

type IndexerCalls = {
  apply: Array<{ addedOrChanged: string[]; removed: string[] }>
  index: Array<{ paths: string[] }>
  remove: Array<{ paths: string[] }>
}
const emptyCalls = (): IndexerCalls => ({ apply: [], index: [], remove: [] })

const makeMockIndexer = (calls?: IndexerCalls): Layer.Layer<CodegraphIndexer.Service> =>
  Layer.succeed(
    CodegraphIndexer.Service,
    CodegraphIndexer.Service.of({
      index: () =>
        Effect.succeed({
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
        }),
      // G1: the auto-update drain uses a single applyChanges per batch.
      applyChanges: (input) =>
        Effect.sync(() => {
          calls?.apply.push({ addedOrChanged: [...input.addedOrChanged], removed: [...input.removed] })
          return { indexed: input.addedOrChanged.length, removed: input.removed.length, skipped: 0, parseErrors: [] }
        }),
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
  calls?: IndexerCalls
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
  test("starts in idle status", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "auto.sqlite"))
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CodegraphAutoUpdate.Service
        expect((yield* svc.state()).status).toBe("idle")
        expect((yield* svc.state()).pending).toBe(0)
      }).pipe(Effect.provide(testLayer({})), Effect.provide(dbLayer), Effect.scoped) as any,
    )
  })

  test("ignores .banyancode, .git, and SQLite sidecar watcher events", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "workspace")
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "auto.sqlite"))
    const calls = emptyCalls()
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const svc = yield* CodegraphAutoUpdate.Service
        const noise = [
          path.join(root, ".banyancode", "banyancode.db-wal"),
          path.join(root, ".banyancode", "banyancode.db-shm"),
          path.join(root, ".banyancode", "banyancode.db-journal"),
          path.join(root, ".banyancode", "banyancode.db"),
          path.join(root, "loose.db-wal"),
          path.join(root, ".banyancode", "agents", "coder.md"),
          // G1: every git command churns these — they must not wake the drain.
          path.join(root, ".git", "index.lock"),
          path.join(root, ".git", "logs", "HEAD"),
          path.join(root, ".git", "FETCH_HEAD"),
        ]
        for (const file of noise) {
          yield* events.publish(
            Watcher.Event.Updated,
            { file, event: "change" },
            { location: { directory: root as never } },
          )
        }
        yield* Effect.sleep(250)
        expect((yield* svc.state()).pending).toBe(0)
        expect((yield* svc.state()).status).toBe("idle")
        expect(calls.apply).toHaveLength(0)
        expect(calls.index).toHaveLength(0)
        expect(calls.remove).toHaveLength(0)
      }).pipe(
        Effect.provide(testLayer({ indexedRoot: root, calls, config: { banyancode_codegraph_watch_debounce_ms: 100 } })),
        Effect.provide(dbLayer),
        Effect.scoped,
      ) as any,
    )
  })

  test("isAutoUpdateIgnoredPath matches .banyancode, .git, and *.db* sidecars", () => {
    expect(CodegraphAutoUpdate.isAutoUpdateIgnoredPath("/repo/.banyancode/banyancode.db-wal")).toBe(true)
    expect(CodegraphAutoUpdate.isAutoUpdateIgnoredPath("D:\\repo\\.banyancode\\memory.db")).toBe(true)
    expect(CodegraphAutoUpdate.isAutoUpdateIgnoredPath("/repo/src/foo.ts")).toBe(false)
    expect(CodegraphAutoUpdate.isAutoUpdateIgnoredPath("/repo/data.db-shm")).toBe(true)
    expect(CodegraphAutoUpdate.isAutoUpdateIgnoredPath("/repo/data.db-journal")).toBe(true)
    // G1: .git internals never wake the indexer.
    expect(CodegraphAutoUpdate.isAutoUpdateIgnoredPath("/repo/.git/index.lock")).toBe(true)
    expect(CodegraphAutoUpdate.isAutoUpdateIgnoredPath("/repo/.git/logs/HEAD")).toBe(true)
    expect(CodegraphAutoUpdate.isAutoUpdateIgnoredPath("D:\\repo\\.git\\FETCH_HEAD")).toBe(true)
    expect(CodegraphAutoUpdate.isAutoUpdateIgnoredPath("/repo/src/git.ts")).toBe(false)
  })

  test("publishes a matching synthetic watcher event and enters draining", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "workspace")
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "auto.sqlite"))
    const calls = emptyCalls()
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
    const calls = emptyCalls()
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const svc = yield* CodegraphAutoUpdate.Service
        for (const file of ["a.ts", "b.ts"]) {
          yield* events.publish(Watcher.Event.Updated, { file: path.join(root, file), event: "change" }, { location: { directory: root as never } })
          yield* Effect.sleep(100)
        }
        yield* Effect.sleep(250)
        // G1: one debounced batch drains via a single applyChanges call.
        expect(calls.apply).toHaveLength(1)
        expect(calls.apply[0].addedOrChanged).toHaveLength(2)
        expect(calls.apply[0].removed).toHaveLength(0)
        expect(calls.index).toHaveLength(0)
        expect(calls.remove).toHaveLength(0)
        expect((yield* svc.state()).pending).toBe(0)
      }).pipe(Effect.provide(testLayer({ indexedRoot: root, calls, config: { banyancode_codegraph_watch_debounce_ms: 100 } })), Effect.provide(dbLayer), Effect.scoped) as any,
    )
  })

  test("delete grace turns unlink followed by add into one reindex", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "workspace")
    const file = path.join(root, "atomic.ts")
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "auto.sqlite"))
    const calls = emptyCalls()
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        yield* events.publish(Watcher.Event.Updated, { file, event: "unlink" }, { location: { directory: root as never } })
        yield* Effect.sleep(120)
        yield* events.publish(Watcher.Event.Updated, { file, event: "add" }, { location: { directory: root as never } })
        yield* Effect.sleep(350)
        // G1: the unlink+add pair resolves to one applyChanges with the path
        // on the added side and nothing on the removed side.
        expect(calls.apply).toHaveLength(1)
        expect(calls.apply[0].addedOrChanged).toEqual([file])
        expect(calls.apply[0].removed).toEqual([])
        expect(calls.remove).toHaveLength(0)
        expect(calls.index).toHaveLength(0)
      }).pipe(Effect.provide(testLayer({ indexedRoot: root, calls, config: { banyancode_codegraph_watch_debounce_ms: 100 } })), Effect.provide(dbLayer), Effect.scoped) as any,
    )
  })

  test("mixed add+remove batch drains via a single applyChanges call", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "workspace")
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "auto.sqlite"))
    const calls = emptyCalls()
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const svc = yield* CodegraphAutoUpdate.Service
        const changed = path.join(root, "changed.ts")
        const deleted = path.join(root, "deleted.ts")
        yield* events.publish(Watcher.Event.Updated, { file: changed, event: "change" }, { location: { directory: root as never } })
        yield* events.publish(Watcher.Event.Updated, { file: deleted, event: "unlink" }, { location: { directory: root as never } })
        yield* Effect.sleep(700)
        // G1: previously removeFiles + indexFiles (two applyChanges runs,
        // two checkpoints, two version bumps); now exactly one call.
        expect(calls.apply).toHaveLength(1)
        expect(calls.apply[0].addedOrChanged).toEqual([changed])
        expect(calls.apply[0].removed).toEqual([deleted])
        expect(calls.index).toHaveLength(0)
        expect(calls.remove).toHaveLength(0)
        expect((yield* svc.state()).pending).toBe(0)
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

  // Phase 8 follow-up (auto-build false triggers): when a workspace marker
  // (e.g. `.banyancode`) exists, the derived root must be the marker's
  // directory — NOT the common parent of the changed files. The old
  // common-parent behavior made the first edit under `packages/opencode/`
  // produce `indexedRoot = <root>/packages/opencode`, and every subsequent
  // workspace-root tool call then saw a root change and forced a full
  // rebuild.
  test("derives the workspace root from a marker dir, not the common parent", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "workspace")
    fs.mkdirSync(path.join(root, ".banyancode"), { recursive: true })
    const file = path.join(root, "packages", "opencode", "x.ts")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "export const x = 1\n")
    const starts: Array<{ root: string; excludePatterns?: readonly string[] }> = []
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "auto.sqlite"))
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        yield* events.publish(Watcher.Event.Updated, { file, event: "add" }, { location: { directory: root as never } })
        yield* Effect.sleep(150)
        expect(starts).toHaveLength(1)
        expect(starts[0].root).toBe(root)
      }).pipe(Effect.provide(testLayer({ starts, config: { banyancode_codegraph_watch_debounce_ms: 100 } })), Effect.provide(dbLayer), Effect.scoped) as any,
    )
  })

  test("converges to watching when the indexer reports skipped paths (no requeue spin)", async () => {    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "workspace")
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "auto.sqlite"))
    const filteredIndexer = Layer.succeed(
      CodegraphIndexer.Service,
      CodegraphIndexer.Service.of({
        index: () => Effect.die("not used") as never,
        // G1: the drain goes through applyChanges; report everything as
        // skipped so the loop must converge without requeueing.
        applyChanges: (input) =>
          Effect.sync(() => ({
            indexed: 0,
            removed: 0,
            skipped: input.addedOrChanged.length + input.removed.length,
            parseErrors: [],
          })),
        indexFiles: (input) =>
          Effect.sync(() => ({
            indexed: 0,
            skipped: input.paths.length,
            parseErrors: [],
          })),
        removeFiles: () => Effect.void,
        cancel: () => Effect.void,
      }),
    )
    const layer = CodegraphAutoUpdate.layer.pipe(
      Layer.provideMerge(EventV2.defaultLayer),
      Layer.provideMerge(filteredIndexer),
      Layer.provideMerge(makeRepo(root)),
      Layer.provideMerge(makeBuildService([])),
      Layer.provideMerge(makeConfig({ banyancode_codegraph_watch_debounce_ms: 100 })),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const svc = yield* CodegraphAutoUpdate.Service
        for (const file of ["a.ts", "b.ts", "c.ts"]) {
          yield* events.publish(
            Watcher.Event.Updated,
            { file: path.join(root, file), event: "change" },
            { location: { directory: root as never } },
          )
        }
        yield* Effect.sleep(400)
        const state = yield* svc.state()
        expect(state.status).toBe("watching")
        expect(state.pending).toBe(0)
      }).pipe(Effect.provide(layer), Effect.provide(dbLayer), Effect.scoped) as any,
    )
  })

  test("flush drains pending paths per root via a single applyChanges without a build", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "workspace")
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "auto.sqlite"))
    const calls = emptyCalls()
    const starts: Array<{ root: string; excludePatterns?: readonly string[] }> = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const svc = yield* CodegraphAutoUpdate.Service
        const changed = path.join(root, "changed.ts")
        const deleted = path.join(root, "deleted.ts")
        yield* events.publish(Watcher.Event.Updated, { file: changed, event: "change" }, { location: { directory: root as never } })
        yield* events.publish(Watcher.Event.Updated, { file: deleted, event: "unlink" }, { location: { directory: root as never } })
        yield* Effect.sleep(200)
        const result = yield* svc.flush({ root })
        expect(result.indexed).toBe(1)
        expect(result.removed).toBe(1)
        // G1: one applyChanges carries both sides of the batch.
        expect(calls.apply).toHaveLength(1)
        expect(calls.apply[0].addedOrChanged).toEqual([changed])
        expect(calls.apply[0].removed).toEqual([deleted])
        expect(calls.index).toHaveLength(0)
        expect(calls.remove).toHaveLength(0)
        expect(starts).toHaveLength(0)
        expect((yield* svc.state()).pending).toBe(0)
      }).pipe(Effect.provide(testLayer({ indexedRoot: root, calls, starts, config: { banyancode_codegraph_watch_debounce_ms: 5000 } })), Effect.provide(dbLayer), Effect.scoped) as any,
    )
  })

  test("reconcile reports size+mtime drift and deleted files with discovered/indexed/removed/cached counts", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "workspace")
    fs.mkdirSync(root, { recursive: true })
    const kept = path.join(root, "kept.ts")
    const touched = path.join(root, "touched.ts")
    const gone = path.join(root, "gone.ts")
    fs.writeFileSync(kept, "export const kept = 1\n")
    fs.writeFileSync(touched, "export const touched = 1\n")
    const keptStat = fs.statSync(kept)
    const { createHash } = await import("node:crypto")
    const hashOf = (s: string) => createHash("sha256").update(s).digest("hex")

    const rows = [
      { id: "f-kept", path: kept, contentHash: hashOf("export const kept = 1\n"), language: "typescript", indexedAt: Date.now(), sizeBytes: keptStat.size, mtimeMs: keptStat.mtimeMs },
      { id: "f-touched", path: touched, contentHash: hashOf("changed content\n"), language: "typescript", indexedAt: Date.now(), sizeBytes: 1, mtimeMs: 1 },
      { id: "f-gone", path: gone, contentHash: "h", language: "typescript", indexedAt: Date.now() },
    ]
    const fullRepo = Layer.succeed(
      CodegraphRepo.Service,
      CodegraphRepo.Service.of({
        getMeta: () => Effect.succeed({ indexedRoot: root } as never),
        listAllFiles: () => Effect.succeed(rows as never),
      } as unknown as CodegraphRepo.Interface),
    )
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "auto.sqlite"))
    const layer = CodegraphAutoUpdate.layer.pipe(
      Layer.provideMerge(EventV2.defaultLayer),
      Layer.provideMerge(makeMockIndexer()),
      Layer.provideMerge(fullRepo),
      Layer.provideMerge(makeBuildService([])),
      Layer.provideMerge(makeConfig({ banyancode_codegraph_watch_debounce_ms: 5000 })),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CodegraphAutoUpdate.Service
        const result = yield* svc.reconcile({ root })
        expect(result.cached).toBe(1)
        expect(result.changed).toBe(1)
        expect(result.removed).toBe(1)
        expect(result.discovered).toBe(0)
      }).pipe(Effect.provide(layer), Effect.provide(dbLayer), Effect.scoped) as any,
    )
  })
})

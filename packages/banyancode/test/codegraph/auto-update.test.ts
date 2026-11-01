/**
 * Auto-update (watcher bridge) tests. `register()` feeds host
 * `filesystem.changed` events into `onChange`; these tests drive the same
 * entry point directly against a real temp repo + real database.
 */
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Storage } from "../../src/storage/index.js"
import { make as makeRepo } from "../../src/codegraph/codegraph-repo.js"
import { make as makeIndexer } from "../../src/codegraph/codegraph-indexer.js"
import { make as makeBuildService } from "../../src/codegraph/codegraph-build-service.js"
import { make as makeAutoUpdate } from "../../src/codegraph/codegraph-auto-update.js"
import { Definition } from "../../src/codegraph/rpc.js"

const withTemp = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-codegraph-auto-"))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const write = async (root: string, path: string, content: string) => {
  const absolute = join(root, path)
  await mkdir(join(absolute, ".."), { recursive: true })
  await writeFile(absolute, content, "utf8")
  return absolute
}

describe("codegraph auto-update", () => {
  test("queues watcher changes and flushes them through the incremental indexer", async () => {
    await withTemp(async (directory) => {
      await write(directory, "src/a.ts", "export function alpha() { return 1 }\n")

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Storage.open({ projectRoot: directory, env: {} })
            const repo = makeRepo(storage)
            const indexer = yield* makeIndexer(repo, storage)
            const buildService = yield* makeBuildService({ indexer, repo, dbPath: () => storage.path })
            const auto = yield* makeAutoUpdate({
              indexer,
              repo,
              buildService,
              projectDirectory: directory,
              dbPath: storage.path,
              config: {
                getWatchOptions: () =>
                  Effect.succeed({ enabled: true, debounceMs: 100, excludePatterns: [] as readonly string[] }),
              },
            })

            const first = yield* indexer.index({ root: directory, force: true })
            expect(first.indexed).toBe(1)
            yield* repo.bumpVersion({ eligibleFiles: first.eligibleFiles, indexedRoot: directory })

            // The plugin's own database writes must never enqueue work.
            yield* auto.onChange({ file: storage.path, event: "change", directory })
            const ignored = yield* auto.flush({ root: directory })
            expect(ignored.indexed).toBe(0)
            expect(ignored.pending).toBe(0)

            const changedPath = yield* Effect.promise(() =>
              write(
                directory,
                "src/a.ts",
                "export function alpha() { return 1 }\nexport function beta() { return 2 }\n",
              ),
            )
            yield* auto.onChange({ file: changedPath, event: "change", directory })
            const flushed = yield* auto.flush({ root: directory })
            expect(flushed.indexed).toBe(1)

            const beta = yield* repo.queryNodes({ function: "beta" })
            expect(beta).toHaveLength(1)

            const state = yield* auto.state()
            expect(state.pending).toBe(0)
          }),
        ),
      )
    })
  })

  test("reconcile detects files deleted from disk", async () => {
    await withTemp(async (directory) => {
      const target = await write(directory, "src/gone.ts", "export function gone() { return 1 }\n")
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Storage.open({ projectRoot: directory, env: {} })
            const repo = makeRepo(storage)
            const indexer = yield* makeIndexer(repo, storage)
            const buildService = yield* makeBuildService({ indexer, repo, dbPath: () => storage.path })
            const auto = yield* makeAutoUpdate({
              indexer,
              repo,
              buildService,
              projectDirectory: directory,
              dbPath: storage.path,
              config: {
                getWatchOptions: () =>
                  Effect.succeed({ enabled: true, debounceMs: 100, excludePatterns: [] as readonly string[] }),
              },
            })
            const first = yield* indexer.index({ root: directory, force: true })
            yield* repo.bumpVersion({ eligibleFiles: first.eligibleFiles, indexedRoot: directory })

            yield* Effect.promise(() => rm(target, { force: true }))
            const probe = yield* auto.reconcile({ root: directory })
            expect(probe.removed).toBe(1)

            const flushed = yield* auto.flush({ root: directory })
            expect(flushed.removed).toBe(1)
            expect(yield* repo.countFiles()).toBe(0)
          }),
        ),
      )
    })
  })
})

describe("codegraph rpc definition", () => {
  test("owns the banyancode.codegraph namespace with parity methods and events", () => {
    expect(Definition.id).toBe("banyancode.codegraph")
    expect(Object.keys(Definition.methods).sort()).toEqual(
      [
        "build",
        "cancel",
        "forceKill",
        "remove",
        "status",
        "nodes",
        "edges",
        "files",
        "staleness",
        "autoUpdate.status",
        "autoUpdate.flush",
        "autoUpdate.reconcile",
      ].sort(),
    )
    expect(Object.keys(Definition.events).sort()).toEqual(["build", "autoUpdate", "autoUpdateProgress"].sort())
  })
})

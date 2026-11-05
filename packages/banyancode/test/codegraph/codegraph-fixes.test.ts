/**
 * Regression tests for the code-graph behaviour findings.
 *
 * Every case drives the real indexer / build service / auto-update / watcher
 * against a temp repo and a real SQLite database — no mocks.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Queue, Ref, Stream } from "effect"
import { Storage } from "../../src/storage/index.js"
import { make as makeRepo } from "../../src/codegraph/codegraph-repo.js"
import { make as makeIndexer } from "../../src/codegraph/codegraph-indexer.js"
import { make as makeBuildService } from "../../src/codegraph/codegraph-build-service.js"
import { make as makeReadiness } from "../../src/codegraph/codegraph-readiness.js"
import { make as makeAutoUpdate } from "../../src/codegraph/codegraph-auto-update.js"
import { watch as fsWatch } from "node:fs"
import { make as makeWatcher, type Update } from "../../src/codegraph/codegraph-watcher.js"
import { make as makeAnalyzer } from "../../src/codegraph/codegraph-analyzer.js"
import { tool as codegraphTool } from "../../src/codegraph/tools/codegraph.js"
import { resolveGraphTargetPure } from "../../src/codegraph/symbol-resolver.js"
import { resolveProjectRoot } from "../../src/codegraph/workspace-identity.js"

const withTemp = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-codegraph-fixes-"))
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

const withServices = async (
  root: string,
  fn: (services: {
    storage: Storage.Interface
    repo: ReturnType<typeof makeRepo>
    indexer: Effect.Success<ReturnType<typeof makeIndexer>>
    buildService: Effect.Success<ReturnType<typeof makeBuildService>>
    readiness: Effect.Success<ReturnType<typeof makeReadiness>>
    analyzer: ReturnType<typeof makeAnalyzer>
    autoUpdate: { state: () => Effect.Effect<{ status: "idle"; pending: number }> }
  }) => Effect.Effect<void, unknown, never>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const storage = yield* Storage.open({ projectRoot: root, env: {} })
        const repo = makeRepo(storage)
        const indexer = yield* makeIndexer(repo, storage)
        const buildService = yield* makeBuildService({ indexer, repo, dbPath: () => storage.path })
        const readiness = yield* makeReadiness({ buildService, repo })
        const autoUpdate = { state: () => Effect.succeed({ status: "idle" as const, pending: 0 }) }
        yield* fn({ storage, repo, indexer, buildService, readiness, analyzer: makeAnalyzer(repo), autoUpdate })
      }),
    ),
  )

const waitFor = <A>(probe: () => Effect.Effect<A>, done: (value: A) => boolean, attempts = 100) =>
  Effect.gen(function* () {
    for (let i = 0; i < attempts; i++) {
      const value = yield* probe()
      if (done(value)) return value
      yield* Effect.sleep("50 millis")
    }
    return yield* probe()
  })

describe("codegraph root resolution", () => {
  test("an omitted root resolves to the open project, never the host cwd", async () => {
    await withTemp(async (project) => {
      await withTemp(async (other) => {
        expect(resolveProjectRoot(project)).toEqual({ _tag: "Ok", root: project })
        const refused = resolveProjectRoot(project, other)
        expect(refused._tag).toBe("Refused")
        if (refused._tag === "Refused") expect(refused.message).toContain("outside the open project")
        // Subfolders of the project stay available (v1 allowed an explicit root).
        const sub = join(project, "packages")
        await mkdir(sub, { recursive: true })
        expect(resolveProjectRoot(project, sub)).toEqual({ _tag: "Ok", root: sub })
        const relative = resolveProjectRoot(project, "packages")
        expect(relative._tag).toBe("Ok")
      })
    })
  })

  test("codegraph_build with no root builds the project, and refuses a folder outside it", async () => {
    await withTemp(async (project) => {
      await write(project, "src/math.ts", "export function add(a: number, b: number) { return a + b }\n")
      await withTemp(async (other) => {
        await write(other, "src/other.ts", "export function elsewhere() { return 1 }\n")
        await withServices(project, ({ repo, buildService, readiness, autoUpdate }) =>
          Effect.gen(function* () {
            const tool = codegraphTool({
              repo,
              buildService,
              readiness,
              autoUpdate: autoUpdate as never,
              projectRoot: () => project,
            })
            const result = yield* tool.execute({ op: "build" }, {} as never)
            expect((result.output as { build: { indexed: number } }).build.indexed).toBe(1)
            const state = yield* buildService.status()
            expect(state.root).toBe(project)
            const files = yield* repo.listAllFiles()
            expect(files.map((f) => f.path).some((p) => p.endsWith("math.ts"))).toBe(true)
            expect(files.map((f) => f.path).some((p) => p.endsWith("other.ts"))).toBe(false)

            const refused = yield* tool.execute({ op: "build", root: other }, {} as never).pipe(
              Effect.match({
                onFailure: (error) => error.message,
                onSuccess: () => "",
              }),
            )
            expect(refused).toContain("outside the open project")
            // The project graph is untouched by the refused build.
            expect((yield* repo.listAllFiles()).map((f) => f.path).some((p) => p.endsWith("other.ts"))).toBe(false)
          }),
        )
      })
    })
  })
})

describe("codegraph exclude patterns", () => {
  test("a build started through readiness applies configured excludes", async () => {
    await withTemp(async (directory) => {
      await write(directory, "src/math.ts", "export function add() { return 1 }\n")
      await write(directory, "docs/readme.md", "# docs\n")
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Storage.open({ projectRoot: directory, env: {} })
            const repo = makeRepo(storage)
            const indexer = yield* makeIndexer(repo, storage)
            const buildService = yield* makeBuildService({ indexer, repo, dbPath: () => storage.path })
            const readiness = yield* makeReadiness({
              buildService,
              repo,
              excludePatterns: () => Effect.succeed(["src/**"]),
            })
            const ready = yield* readiness.ensureReady({ root: directory })
            expect(ready.reason).toBe("ready")
            const files = (yield* repo.listAllFiles()).map((f) => f.path.replace(/\\/g, "/"))
            expect(files.some((p) => p.endsWith("src/math.ts"))).toBe(false)
            expect(files.some((p) => p.endsWith("docs/readme.md"))).toBe(true)
          }),
        ),
      )
    })
  })

  test("codegraph_build applies the configured exclude patterns", async () => {
    await withTemp(async (directory) => {
      await write(directory, "src/math.ts", "export function add() { return 1 }\n")
      await write(directory, "docs/readme.md", "# docs\n")
      await withServices(directory, ({ repo, buildService, readiness, autoUpdate }) =>
        Effect.gen(function* () {
          const tool = codegraphTool({
            repo,
            buildService,
            readiness,
            autoUpdate: autoUpdate as never,
            projectRoot: () => directory,
            excludePatterns: () => Effect.succeed(["src/**"]),
          })
          yield* tool.execute({ op: "build" }, {} as never)
          const files = (yield* repo.listAllFiles()).map((f) => f.path.replace(/\\/g, "/"))
          expect(files.some((p) => p.endsWith("src/math.ts"))).toBe(false)
          expect(files.some((p) => p.endsWith("docs/readme.md"))).toBe(true)
        }),
      )
    })
  })
})

describe("codegraph cross-file caller edges", () => {
  test("resolves namespaced calls imported with a .js ESM specifier", async () => {
    await withTemp(async (directory) => {
      await write(
        directory,
        "core/util/wildcard.ts",
        ["export function match(value: string) {", "  return value", "}"].join("\n"),
      )
      await write(
        directory,
        "core/permission.ts",
        [
          'import { Wildcard } from "./util/wildcard.js"',
          "",
          "export function check(value: string) {",
          '  return Wildcard.match(value) === "ok"',
          "}",
        ].join("\n"),
      )
      await withServices(directory, ({ repo, indexer }) =>
        Effect.gen(function* () {
          yield* indexer.index({ root: directory, force: true })
          const analyzer = makeAnalyzer(repo)
          const callers = yield* analyzer.callers({ function: "match" }).pipe(Effect.orElseSucceed(() => []))
          expect(callers.map((node) => node.name)).toContain("check")
        }),
      )
    })
  })
})

describe("codegraph skip buckets", () => {
  test("a directory in .banyancode/ignore counts as banyanignored, not gitignored", async () => {
    await withTemp(async (directory) => {
      await write(directory, "src/kept.ts", "export function kept() { return 1 }\n")
      await write(directory, "e-ig/nested/ignored.ts", "export function invisible() { return 1 }\n")
      await write(directory, ".banyancode/ignore", "e-ig/\n")
      await withServices(directory, ({ repo, indexer }) =>
        Effect.gen(function* () {
          const result = yield* indexer.index({ root: directory, force: true })
          // Before the bucket fix the ignored directory was counted as
          // gitignored and banyanignored stayed 0.
          expect(result.skippedByReason.banyanignored).toBe(1)
          const files = (yield* repo.listAllFiles()).map((f) => f.path.replace(/\\/g, "/"))
          expect(files.some((p) => p.endsWith("e-ig/nested/ignored.ts"))).toBe(false)
        }),
      )
    })
  })
})

describe("codegraph parse errors", () => {
  test("valid TSX and variance annotations are not reported as syntax errors", async () => {
    await withTemp(async (directory) => {
      await write(
        directory,
        "ui/footer.tsx",
        [
          "export function Footer(props: { label: string }) {",
          "  return <div>{props.label}</div>",
          "}",
        ].join("\n"),
      )
      await write(directory, "core/keyed-mutex.ts", "export interface KeyedMutex<in Key> {\n  get(key: Key): void\n}\n")
      await write(
        directory,
        "core/variance.ts",
        [
          "export class Box<in T> {",
          "  read(value: T) {",
          "    return value",
          "  }",
          "}",
          "export function wrap<out T>(value: T) {",
          "  return value",
          "}",
        ].join("\n"),
      )
      // The vendor grammar predates these valid constructs; every one of
      // them used to be recorded as a parse failure.
      await write(
        directory,
        "core/variance-tables.ts",
        [
          "export interface SQLiteInsertBase<in out TTable extends SQLiteTable, out TRunResult, out TReturning = undefined> {",
          "  run(): TReturning",
          "}",
        ].join("\n"),
      )
      await write(directory, "core/type-star.ts", 'export type * from "@anthropic-ai/claude-agent-sdk"\n')
      await write(
        directory,
        "core/bus.ts",
        [
          "export interface Subscribe {",
          "  (): Stream.Stream<Event.Payload>",
          "  <D extends Event.Definition>(definition: D): Stream.Stream<Event.Payload<D>>",
          "  <const D extends readonly [Event.Definition, ...Event.Definition[]]>(",
          "    definitions: D,",
          "  ): Stream.Stream<SubscribePayload<D>>",
          "}",
        ].join("\n"),
      )
      await write(
        directory,
        "core/history.ts",
        [
          "export const text = (db: Db) =>",
          "  db.select({",
          "    text: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.text')`,",
          "  })",
          "export const count = sql<{ count: number }>`select count(*) as count`",
        ].join("\n"),
      )
      await withServices(directory, ({ repo, indexer }) =>
        Effect.gen(function* () {
          const result = yield* indexer.index({ root: directory, force: true })
          expect(result.skippedByReason.parseFailure).toBe(0)
          expect(result.parseErrors).toEqual([])
          expect(yield* repo.listParseErrors()).toEqual([])
          const files = (yield* repo.listAllFiles()).map((f) => f.path.replace(/\\/g, "/"))
          expect(files.some((p) => p.endsWith("ui/footer.tsx"))).toBe(true)
          expect(files.some((p) => p.endsWith("core/keyed-mutex.ts"))).toBe(true)
        }),
      )
    })
  })

  test("a real syntax error is still reported", async () => {
    await withTemp(async (directory) => {
      await write(directory, "src/broken.ts", "export function broken( {\n")
      await withServices(directory, ({ repo, indexer }) =>
        Effect.gen(function* () {
          const result = yield* indexer.index({ root: directory, force: true })
          expect(result.skippedByReason.parseFailure).toBe(1)
          expect(result.parseErrors[0]?.cause).toContain("tree-sitter syntax error")
          expect((yield* repo.listParseErrors()).map((e) => e.path)).toContain("src/broken.ts")
        }),
      )
    })
  })
})

describe("codegraph build lifecycle", () => {
  const seedMany = async (root: string, count: number) => {
    for (let i = 0; i < count; i++) {
      await write(root, `src/file${i}.ts`, `export function fn${i}() { return ${i} }\n`)
    }
  }

  test("cancel reports cancelled and the status does not stick at failed", async () => {
    await withTemp(async (directory) => {
      await seedMany(directory, 200)
      await withServices(directory, ({ buildService }) =>
        Effect.gen(function* () {
          yield* buildService.start({ root: directory, force: true })
          yield* buildService.cancel()
          const cancelled = yield* buildService.status()
          expect(cancelled.status).toBe("cancelled")
          // Give the sequencing fiber time to write its terminal state; it
          // must not overwrite the cancel with "failed".
          yield* Effect.sleep("150 millis")
          expect((yield* buildService.status()).status).toBe("cancelled")
        }),
      )
    })
  })

  test("a second start while a build runs keeps the running build", async () => {
    await withTemp(async (directory) => {
      await seedMany(directory, 200)
      await withServices(directory, ({ buildService }) =>
        Effect.gen(function* () {
          yield* buildService.start({ root: directory, force: true })
          const first = yield* buildService.status()
          expect(first.status).toBe("running")
          expect(first.startedAt).toBeDefined()

          yield* buildService.start({ root: join(directory, "src"), force: true })
          const second = yield* buildService.status()
          expect(second.startedAt).toBe(first.startedAt!)
          expect(second.root).toBe(first.root!)

          yield* buildService.cancel()
        }),
      )
    })
  })

  test("two starts that overlap during preparation run one build", async () => {
    await withTemp(async (directory) => {
      await seedMany(directory, 200)
      await withServices(directory, ({ indexer, repo }) =>
        Effect.scoped(
          Effect.gen(function* () {
          const indexCalls = yield* Ref.make(0)
          const countingIndexer = {
            ...indexer,
            index: (input: Parameters<typeof indexer.index>[0]) =>
              Ref.update(indexCalls, (count) => count + 1).pipe(Effect.andThen(indexer.index(input))),
          }
          // A real metadata read can yield long enough for a second HTTP
          // request to enter start(); the delay makes that overlap
          // deterministic without mocking the database.
          const slowRepo = {
            ...repo,
            getMeta: () => Effect.sleep("60 millis").pipe(Effect.andThen(repo.getMeta())),
          }
          const buildService = yield* makeBuildService({
            indexer: countingIndexer,
            repo: slowRepo,
            dbPath: () => "/tmp/unused.db",
          })

          yield* Effect.all(
            [
              buildService.start({ root: directory, force: true }),
              Effect.sleep("10 millis").pipe(
                Effect.andThen(buildService.start({ root: join(directory, "src"), force: true })),
              ),
            ],
            { concurrency: 2 },
          )
          yield* Effect.sleep("200 millis")

          expect(yield* Ref.get(indexCalls)).toBe(1)
          const state = yield* buildService.status()
          expect(state.root).toBe(directory)
          yield* buildService.cancel()
          }),
        ),
      )
    })
  })

  test("status reports an enumerating phase before the file count is known", async () => {
    await withTemp(async (directory) => {
      await seedMany(directory, 200)
      await withServices(directory, ({ buildService }) =>
        Effect.gen(function* () {
          yield* buildService.start({ root: directory, force: true })
          const running = yield* buildService.status()
          if (running.status === "running") {
            expect(running.phase).toBe("enumerating")
            expect(running.total).toBe(0)
          }
          let final = yield* buildService.status()
          for (let i = 0; i < 400 && final.status === "running"; i++) {
            yield* Effect.sleep("25 millis")
            final = yield* buildService.status()
          }
          expect(final.status).toBe("completed")
        }),
      )
    })
  })

  test("a refused start is visible in the build status", async () => {
    await withTemp(async (directory) => {
      await withServices(directory, ({ buildService }) =>
        Effect.gen(function* () {
          yield* buildService.reportRefused("codegraph build refused: root '/elsewhere' is outside the open project")
          const state = yield* buildService.status()
          expect(state.status).toBe("failed")
          expect(state.error).toContain("outside the open project")
        }),
      )
    })
  })

  test("reset after remove clears the last-run state", async () => {
    await withTemp(async (directory) => {
      await write(directory, "src/a.ts", "export function a() { return 1 }\n")
      await withServices(directory, ({ repo, indexer, buildService }) =>
        Effect.gen(function* () {
          yield* buildService.start({ root: directory, force: true })
          let state = yield* buildService.status()
          for (let i = 0; i < 200 && state.status === "running"; i++) {
            yield* Effect.sleep("25 millis")
            state = yield* buildService.status()
          }
          expect(state.status).toBe("completed")

          yield* repo.clearAll({ dropFile: false })
          yield* buildService.reset()
          const idle = yield* buildService.status()
          expect(idle.status).toBe("idle")
          expect(idle.done).toBe(0)
          expect(idle.total).toBe(0)
          expect(idle.result).toBeUndefined()
        }),
      )
    })
  })
})

describe("codegraph removal", () => {
  test("clearAll vacuums and reports the bytes it freed", async () => {
    await withTemp(async (directory) => {
      await write(directory, "src/a.ts", "export function a() { return 1 }\n")
      await withServices(directory, ({ repo, indexer }) =>
        Effect.gen(function* () {
          for (let i = 0; i < 120; i++) {
            yield* Effect.promise(() =>
              write(directory, `src/f${i}.ts`, `export function fn${i}() { return ${i} }\n`.repeat(20)),
            )
          }
          yield* indexer.index({ root: directory, force: true })
          const cleared = yield* repo.clearAll({ dropFile: false })
          expect(cleared.sizeBefore).toBeGreaterThan(0)
          expect(cleared.sizeAfter).toBeLessThan(cleared.sizeBefore)
        }),
      )
    })
  })

  test("--drop-file clears the open database and the next build persists real data", async () => {
    await withTemp(async (directory) => {
      await write(directory, "src/a.ts", "export function a() { return 1 }\n")
      await withServices(directory, ({ storage, repo, indexer }) =>
        Effect.gen(function* () {
          yield* indexer.index({ root: directory, force: true })
          expect(existsSync(`${storage.path}-wal`)).toBe(true)

          const cleared = yield* repo.clearAll({ dropFile: true })
          // The database is open, so it is emptied rather than unlinked (an
          // unlinked file would swallow every later build on POSIX and the
          // unlink silently fails on Windows).
          expect(cleared.droppedFile).toBe(false)
          expect(existsSync(storage.path)).toBe(true)
          expect(yield* repo.countNodes()).toBe(0)
          expect(yield* repo.countFiles()).toBe(0)
          expect(statSync(`${storage.path}-wal`).size).toBe(0)

          // A build right after --drop-file writes real rows into the file.
          yield* Effect.promise(() => write(directory, "src/b.ts", "export function afterDrop() { return 2 }\n"))
          const rebuild = yield* indexer.index({ root: directory, force: true })
          expect(rebuild.indexed).toBeGreaterThan(0)
          expect(yield* repo.countNodes()).toBeGreaterThan(0)
          expect((yield* repo.listAllFiles()).map((file) => file.path).some((p) => p.endsWith("b.ts"))).toBe(true)
          // The node is queryable through the shared resolver, i.e. the build
          // wrote into the same (still open) database the tools read.
          const found = yield* resolveGraphTargetPure(repo, { target: "afterDrop" })
          expect(found._tag).toBe("Ok")
        }),
      )
    })
  })
})

describe("codegraph auto-update", () => {
  test("status is watching when the watcher is enabled and idle when disabled", async () => {
    await withTemp(async (directory) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Storage.open({ projectRoot: directory, env: {} })
            const repo = makeRepo(storage)
            const indexer = yield* makeIndexer(repo, storage)
            const buildService = yield* makeBuildService({ indexer, repo, dbPath: () => storage.path })
            const enabled = yield* makeAutoUpdate({
              indexer,
              repo,
              buildService,
              projectDirectory: directory,
              dbPath: storage.path,
              config: {
                getWatchOptions: () => Effect.succeed({ enabled: true, debounceMs: 50, excludePatterns: [] }),
              },
            })
            expect((yield* enabled.state()).status).toBe("watching")

            // A queued change flips the status to draining until the batch runs.
            yield* enabled.onChange({ file: join(directory, "src", "a.ts"), event: "change", directory })
            const draining = yield* enabled.state()
            expect(draining.status).toBe("draining")
            expect(draining.pending).toBe(1)
            expect(draining.lastChangeAt).toBeDefined()

            const disabled = yield* makeAutoUpdate({
              indexer,
              repo,
              buildService,
              projectDirectory: directory,
              dbPath: storage.path,
              config: {
                getWatchOptions: () => Effect.succeed({ enabled: false, debounceMs: 50, excludePatterns: [] }),
              },
            })
            expect((yield* disabled.state()).status).toBe("idle")
          }),
        ),
      )
    })
  })

  test("a real file edit reaches auto-update through the project watcher", async () => {
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
                getWatchOptions: () => Effect.succeed({ enabled: true, debounceMs: 50, excludePatterns: [] }),
              },
            })
            const first = yield* indexer.index({ root: directory, force: true })
            yield* repo.bumpVersion({ eligibleFiles: first.eligibleFiles, indexedRoot: directory })

            yield* makeWatcher({
              root: directory,
              onChange: auto.onChange,
              updates: Stream.callback<Update>((queue) =>
                Effect.acquireRelease(
                  Effect.sync(() =>
                    fsWatch(directory, { recursive: true }, (_event, filename) => {
                      if (filename) Queue.offerUnsafe(queue, { path: join(directory, filename.toString()), type: "update" })
                    }),
                  ),
                  (handle) => Effect.sync(() => handle.close()),
                ),
              ),
            })
            yield* Effect.sleep("200 millis")

            yield* Effect.promise(() =>
              write(
                directory,
                "src/a.ts",
                "export function alpha() { return 1 }\nexport function beta() { return 2 }\n",
              ),
            )

            const beta = yield* waitFor(
              () => repo.queryNodes({ function: "beta" }),
              (nodes) => nodes.length > 0,
            )
            expect(beta).toHaveLength(1)
            // One save can raise more than one event, so a second pass may still be queued.
            const state = yield* waitFor(
              () => auto.state(),
              (current) => current.pending === 0,
            )
            expect(["watching", "draining"]).toContain(state.status)
            expect(state.pending).toBe(0)
          }),
        ),
      )
    })
  })
})

import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { CodegraphIndexer } from "@opencode-ai/core/banyancode/codegraph-indexer"
import { CodegraphReadiness } from "@opencode-ai/core/banyancode/codegraph-readiness"
import { CodegraphRepo, CODEGRAPH_SCHEMA_VERSION } from "@opencode-ai/core/banyancode/codegraph-repo"
import { CodegraphBuildService } from "@opencode-ai/core/banyancode/codegraph-build-service"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import path from "node:path"
import fs from "node:fs"

process.env.BANYANCODE_ENABLE = "1"

const idleIndexer = Layer.succeed(
  CodegraphIndexer.Service,
  CodegraphIndexer.Service.of({
    index: () =>
      Effect.succeed({
        indexed: 1,
        skipped: 0,
        scannedFiles: 1,
        eligibleFiles: 1,
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
    indexFiles: () => Effect.succeed({ indexed: 0, skipped: 0, parseErrors: [] }),
    removeFiles: () => Effect.void,
    cancel: () => Effect.void,
  }),
)

const buildReadinessLayer = (dbPath: string) => {
  // Construct the readiness graph using each service's bare `layer`
  // (not `defaultLayer`) so we can wire deps explicitly. We use
  // `Layer.provideMerge` (not just `Layer.provide`) so that
  // CodegraphReadiness.Service and CodegraphRepo.Service end up in the
  // COMPOSITE layer's output — tests that yield both services in the
  // same Effect.gen then resolve R to `never` after `Effect.provide`.
  // Inlining `Database.layerFromPath(dbPath)` directly into the
  // codegraphRepoLayer pipe is what eliminates `Database.Service` from
  // R — providing Database in a separate pipe after the fact leaves
  // `Database.Service` in R and Effect.gen tests reject the effect.
  return CodegraphReadiness.layer.pipe(
    Layer.provide(CodegraphBuildService.layer),
    Layer.provide(idleIndexer),
    Layer.provideMerge(CodegraphRepo.layer.pipe(Layer.provide(Database.layerFromPath(dbPath)))),
    Layer.provideMerge(FSUtil.defaultLayer),
  )
}

describe("CodegraphReadiness", () => {
  test("status() reports a structured ReadinessResult with reason and autoBuilt fields", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "readiness-empty.db")
    const layer = buildReadinessLayer(dbPath)

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* CodegraphReadiness.Service
          return yield* svc.status()
        }).pipe(Effect.provide(layer)),
      ),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(typeof exit.value.reason).toBe("string")
      expect(["ready", "missing", "stale", "building", "failed"]).toContain(exit.value.reason)
      expect(typeof exit.value.autoBuilt).toBe("boolean")
    }
  })

  // Phase 2: regression test for the mtime-on-cached-file trap. A freshly
  // built graph whose only file has mtime > indexed_at used to trigger a
  // 50-70s blocking rebuild every time. After the fix, ensureReady
  // returns ready immediately (autoBuilt: false) as long as the content
  // hash still matches and the structural conditions (meta missing,
  // empty file table, root change, schemaStale) are not met.
  test("ensureReady does NOT rebuild when mtime > indexed_at but content is unchanged", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "readiness-mtime.db")
    const repoDir = path.join(tmp.path, "src")
    const filePath = path.join(repoDir, "a.ts")
    fs.mkdirSync(repoDir, { recursive: true })
    fs.writeFileSync(filePath, "export const a = 1\n")

    const layer = buildReadinessLayer(dbPath)
    const { CodegraphRepo } = await import("@opencode-ai/core/banyancode/codegraph-repo")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          // Seed a file row and meta as if a previous build had indexed
          // this file. The row's indexedAt is in the past, so by the time
          // we touch the file, mtimeMs > indexedAt — exactly the cached
          // file trap that used to trigger endless rebuilds.
          yield* repo.putFile({
            id: "f1",
            path: filePath,
            contentHash: "h1",
            language: "typescript",
            indexedAt: Date.now() - 60_000,
          })
          yield* repo.setMeta({
            id: "singleton",
            graphBuiltAt: Date.now() - 60_000,
            graphVersion: 1,
            graphCoverage: 1,
            totalFiles: 1,
            totalNodes: 0,
            totalEdges: 0,
            schemaVersion: 3,
            indexedRoot: repoDir,
          })
          // Update the file's mtime to a fresh timestamp WITHOUT changing
          // its content. Now mtimeMs > indexedAt but contentHash matches.
          const future = Date.now() / 1000 + 5
          fs.utimesSync(filePath, future, future)
        }).pipe(Effect.provide(layer)),
      ),
    )

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* CodegraphReadiness.Service
          return yield* svc.ensureReady({ root: repoDir })
        }).pipe(Effect.provide(layer)),
      ),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.reason).toBe("ready")
      expect(exit.value.autoBuilt).toBe(false)
    }
  })

  // Phase 2: the cached-file scenario. Write file A, build, touch file A
  // with no content change, call ensureReady again. The new behaviour
  // must return ready immediately without spawning any build.
  test("ensureReady returns ready immediately when a cached file is touched with no content change", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "readiness-cached.db")
    const repoDir = path.join(tmp.path, "src")
    const filePath = path.join(repoDir, "a.ts")
    fs.mkdirSync(repoDir, { recursive: true })
    const originalContent = "export const a = 1\n"
    fs.writeFileSync(filePath, originalContent)

    const layer = buildReadinessLayer(dbPath)
    const { CodegraphRepo } = await import("@opencode-ai/core/banyancode/codegraph-repo")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          yield* repo.putFile({
            id: "f1",
            path: filePath,
            contentHash: "h1",
            language: "typescript",
            indexedAt: Date.now() - 60_000,
          })
          yield* repo.setMeta({
            id: "singleton",
            graphBuiltAt: Date.now() - 60_000,
            graphVersion: 1,
            graphCoverage: 1,
            totalFiles: 1,
            totalNodes: 0,
            totalEdges: 0,
            schemaVersion: 3,
            indexedRoot: repoDir,
          })
          // Touch file A with no content change — mtime advances, but
          // content and contentHash stay the same.
          const future = Date.now() / 1000 + 5
          fs.utimesSync(filePath, future, future)
        }).pipe(Effect.provide(layer)),
      ),
    )

    const start = Date.now()
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* CodegraphReadiness.Service
          return yield* svc.ensureReady({ root: repoDir })
        }).pipe(Effect.provide(layer)),
      ),
    )
    const elapsed = Date.now() - start

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.reason).toBe("ready")
      expect(exit.value.autoBuilt).toBe(false)
    }
    // The readiness call must return fast — no build was spawned, no
    // 500ms poll loop ran. A loose upper bound of 2s accommodates CI
    // jitter while still catching a regression that re-introduces the
    // 50-500ms polling loop.
    expect(elapsed).toBeLessThan(2_000)
  })

  // Phase 2: age is now a warning, not a rebuild trigger. A graph built
  // 8 days ago but with content unchanged must return ready/false
  // (assuming structural conditions are fine). The 7-day threshold is
  // also the warning cutoff.
  test("ensureReady treats age > 7 days as a warning, not a rebuild trigger", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "readiness-age.db")
    const repoDir = path.join(tmp.path, "src")
    const filePath = path.join(repoDir, "a.ts")
    fs.mkdirSync(repoDir, { recursive: true })
    fs.writeFileSync(filePath, "export const a = 1\n")

    const layer = buildReadinessLayer(dbPath)
    const { CodegraphRepo } = await import("@opencode-ai/core/banyancode/codegraph-repo")
    const now = Date.now()
    const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          yield* repo.putFile({
            id: "f1",
            path: filePath,
            contentHash: "h1",
            language: "typescript",
            indexedAt: now - EIGHT_DAYS_MS,
          })
          yield* repo.setMeta({
            id: "singleton",
            graphBuiltAt: now - EIGHT_DAYS_MS,
            graphVersion: 1,
            graphCoverage: 1,
            totalFiles: 1,
            totalNodes: 0,
            totalEdges: 0,
            schemaVersion: 3,
            indexedRoot: repoDir,
          })
        }).pipe(Effect.provide(layer)),
      ),
    )

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* CodegraphReadiness.Service
          return yield* svc.ensureReady({ root: repoDir })
        }).pipe(Effect.provide(layer)),
      ),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.reason).toBe("ready")
      expect(exit.value.autoBuilt).toBe(false)
      // The warning is attached to the readiness result, not used to
      // trigger a rebuild.
      expect(exit.value.warning).toBeDefined()
      expect(exit.value.warning).toContain("days old")
    }
  })

  // Phase 2: missing meta → force rebuild (this is the only timing of
  // the old `force` path that still triggers an auto-build).
  test("ensureReady auto-builds when meta is missing", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "readiness-missing-meta.db")
    const repoDir = path.join(tmp.path, "src")
    fs.mkdirSync(repoDir, { recursive: true })

    const layer = buildReadinessLayer(dbPath)

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* CodegraphReadiness.Service
          return yield* svc.ensureReady({ root: repoDir })
        }).pipe(Effect.provide(layer)),
      ),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.autoBuilt).toBe(true)
    }
  })

  // Phase 8 follow-up (auto-build false triggers): a caller passing the SAME
  // workspace under a different spelling (win32 case variant, or a symlink/
  // junction on POSIX) must NOT be treated as a root change. Before the fix
  // `rootChanged` compared `meta.indexedRoot !== root` after a plain
  // `path.resolve`, so a case/symlink drift forced a full rebuild on EVERY
  // tool call. Now both sides are canonicalized (realpath + win32 case fold).
  test("ensureReady does NOT rebuild when the same root is spelled differently", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "readiness-root-spelling.db")
    const repoDir = path.join(tmp.path, "src")
    const filePath = path.join(repoDir, "a.ts")
    fs.mkdirSync(repoDir, { recursive: true })
    fs.writeFileSync(filePath, "export const a = 1\n")

    const layer = buildReadinessLayer(dbPath)
    const { CodegraphRepo } = await import("@opencode-ai/core/banyancode/codegraph-repo")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          yield* repo.putFile({
            id: "f1",
            path: filePath,
            contentHash: "h1",
            language: "typescript",
            indexedAt: Date.now(),
          })
          yield* repo.setMeta({
            id: "singleton",
            graphBuiltAt: Date.now(),
            graphVersion: 1,
            graphCoverage: 1,
            totalFiles: 1,
            totalNodes: 0,
            totalEdges: 0,
            schemaVersion: CODEGRAPH_SCHEMA_VERSION,
            indexedRoot: repoDir,
          })
        }).pipe(Effect.provide(layer)),
      ),
    )

    // Alternate spelling of the SAME directory: win32 drive-case swap,
    // otherwise a symlink alias.
    let altSpelling: string
    if (process.platform === "win32") {
      const drive = repoDir.charAt(0)
      const swapped = drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()
      altSpelling = swapped + repoDir.slice(1)
    } else {
      const link = path.join(tmp.path, "src-link")
      try {
        fs.symlinkSync(repoDir, link, "dir")
      } catch {
        fs.symlinkSync(repoDir, link)
      }
      altSpelling = link
    }

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* CodegraphReadiness.Service
          return yield* svc.ensureReady({ root: altSpelling })
        }).pipe(Effect.provide(layer)),
      ),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.reason).toBe("ready")
      expect(exit.value.autoBuilt).toBe(false)
    }
  })

  // Phase 8 follow-up (auto-build false triggers): a stale schema version
  // rebuilds exactly ONCE, then converges to `ready`. The version literal is
  // shared between the writer (CodegraphRepo.bumpVersion) and the reader
  // (CodegraphReadiness) via CODEGRAPH_SCHEMA_VERSION so the two can never
  // drift into a perpetual-rebuild loop.
  test("ensureReady rebuilds once on a stale schema version, then converges", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "readiness-schema.db")
    const repoDir = path.join(tmp.path, "src")
    fs.mkdirSync(repoDir, { recursive: true })

    const layer = buildReadinessLayer(dbPath)
    const { CodegraphRepo } = await import("@opencode-ai/core/banyancode/codegraph-repo")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          yield* repo.putFile({
            id: "f1",
            path: path.join(repoDir, "a.ts"),
            contentHash: "h1",
            language: "typescript",
            indexedAt: Date.now(),
          })
          yield* repo.setMeta({
            id: "singleton",
            graphBuiltAt: Date.now(),
            graphVersion: 1,
            graphCoverage: 1,
            totalFiles: 1,
            totalNodes: 0,
            totalEdges: 0,
            schemaVersion: CODEGRAPH_SCHEMA_VERSION - 1,
            indexedRoot: repoDir,
          })
        }).pipe(Effect.provide(layer)),
      ),
    )

    const first = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* CodegraphReadiness.Service
          return yield* svc.ensureReady({ root: repoDir })
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(Exit.isSuccess(first)).toBe(true)
    if (Exit.isSuccess(first)) {
      expect(first.value.autoBuilt).toBe(true)
    }

    const second = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* CodegraphReadiness.Service
          return yield* svc.ensureReady({ root: repoDir })
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(Exit.isSuccess(second)).toBe(true)
    if (Exit.isSuccess(second)) {
      expect(second.value.reason).toBe("ready")
      expect(second.value.autoBuilt).toBe(false)
    }
  })
})


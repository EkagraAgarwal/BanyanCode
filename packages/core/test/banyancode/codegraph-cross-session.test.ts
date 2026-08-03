import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { mkdirSync } from "node:fs"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { WorkspaceIdentity } from "../../src/banyancode/workspace-identity"
import { channelSuffix } from "../../src/database/banyan-db-path"

process.env.BANYANCODE_ENABLE = "1"

describe("CodegraphIndexer cross-session behavior", () => {
  test("indexFiles updates graphBuiltAt", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const fileA = path.join(tmp.path, "a.ts")
    const fileB = path.join(tmp.path, "b.ts")
    const fileC = path.join(tmp.path, "c.ts")

    await fs.writeFile(fileA, "function foo() { return 42 }\n")
    await fs.writeFile(fileB, "function bar() { return 99 }\n")
    await fs.writeFile(fileC, "function baz() { return 100 }\n")

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service

        // Index two files
        yield* indexer.indexFiles({ root: tmp.path, paths: [fileA, fileB] })

        // Read meta after first indexing
        const prevMeta = yield* repo.getMeta()
        expect(prevMeta).toBeDefined()
        expect(prevMeta!.graphBuiltAt).toBeGreaterThan(0)
        const prevBuiltAt = prevMeta!.graphBuiltAt

        // Add third file
        yield* indexer.indexFiles({ root: tmp.path, paths: [fileC] })

        // graphBuiltAt should be updated
        const newMeta = yield* repo.getMeta()
        expect(newMeta).toBeDefined()
        expect(newMeta!.graphBuiltAt).toBeGreaterThan(prevBuiltAt)
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("removeFiles is a no-op when file is not in the graph", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const fileA = path.join(tmp.path, "a.ts")
    const nonexistent = path.join(tmp.path, "nonexistent.ts")

    await fs.writeFile(fileA, "function foo() { return 42 }\n")

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service

        // Index fileA
        yield* indexer.indexFiles({ root: tmp.path, paths: [fileA] })

        // Read graphVersion before
        const beforeMeta = yield* repo.getMeta()
        expect(beforeMeta).toBeDefined()
        const beforeVersion = beforeMeta!.graphVersion

        // Try to remove a file that was never indexed
        yield* indexer.removeFiles({ root: tmp.path, paths: [nonexistent] })

        // graphVersion should be unchanged
        const afterMeta = yield* repo.getMeta()
        expect(afterMeta).toBeDefined()
        expect(afterMeta!.graphVersion).toBe(beforeVersion)
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("cross-session persistence - meta and files survive DB reopen", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    const fileA = path.join(tmp.path, "a.ts")
    const fileB = path.join(tmp.path, "b.ts")

    await fs.writeFile(fileA, "function foo() { return 42 }\n")
    await fs.writeFile(fileB, "function bar() { return 99 }\n")

    // Session 1: index two files
    const dbLayer1 = Database.layerFromPath(dbPath)
    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service

        yield* indexer.indexFiles({ root: tmp.path, paths: [fileA, fileB] })

        // Verify meta is set
        const meta = yield* repo.getMeta()
        expect(meta).toBeDefined()
        expect(meta!.graphVersion).toBeGreaterThan(0)
        expect(meta!.totalFiles).toBeGreaterThanOrEqual(2)
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer1),
        Effect.scoped,
      ),
    )

    // Session 2: reopen DB at same path, verify data persists
    const dbLayer2 = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        // Verify meta persisted
        const meta = yield* repo.getMeta()
        expect(meta).toBeDefined()
        expect(meta!.graphVersion).toBeGreaterThan(0)

        // Verify files persisted
        const files = yield* repo.listAllFiles()
        expect(files.length).toBeGreaterThanOrEqual(2)

        const paths = files.map((f) => f.path)
        expect(paths).toContain(fileA)
        expect(paths).toContain(fileB)
      }).pipe(
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer2),
        Effect.scoped,
      ),
    )
  })

  // Phase 2 (canonical graph DB identity): Database.path() (cwd-keyed) and
  // WorkspaceIdentity.identityForRoot (root-keyed) must derive the SAME DB
  // file when the server starts from the workspace root — same realpath hash
  // AND same installation-channel suffix.
  test("Database.path() and identityForRoot agree on the DB file when cwd is the root", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path
    mkdirSync(path.join(root, ".banyancode"), { recursive: true })
    const originalCwd = process.cwd

    try {
      Object.defineProperty(process, "cwd", {
        value: () => root,
        configurable: true,
      })
      const identity = WorkspaceIdentity.identityForRoot(root)
      // The identity filename now carries the same channel suffix as
      // Database.path(), so the two derivations line up.
      expect(identity.dbPath).toBe(
        path.join(identity.banyanDir, `banyancode-${identity.tag}${channelSuffix()}.db`),
      )
      expect(Database.path()).toBe(identity.dbPath)
    } finally {
      Object.defineProperty(process, "cwd", {
        value: originalCwd,
        configurable: true,
      })
    }
  })

  // Phase 2 (canonical graph DB identity): a build bound to an explicit root
  // via Database.layerFromRoot(root) writes meta into the identity-derived
  // dbPath. Reopening that SAME dbPath from a DIFFERENT cwd (the restart-
  // from-another-directory scenario) must still find the meta, and a truly
  // different workspace root must remain isolated (its own DB, no meta).
  test("root-bound DB identity survives a different cwd and isolates other roots", async () => {
    await using tmp = await tmpdir()
    const root1 = path.join(tmp.path, "ws1")
    const root2 = path.join(tmp.path, "ws2")
    mkdirSync(path.join(root1, ".banyancode"), { recursive: true })
    mkdirSync(path.join(root2, ".banyancode"), { recursive: true })
    const fileA = path.join(root1, "a.ts")
    const fileB = path.join(root2, "b.ts")
    await fs.writeFile(fileA, "function foo() { return 42 }\n")
    await fs.writeFile(fileB, "function bar() { return 99 }\n")

    const identity1 = WorkspaceIdentity.identityForRoot(root1)
    const identity2 = WorkspaceIdentity.identityForRoot(root2)
    expect(identity1.dbPath).not.toBe(identity2.dbPath)

    // Session 1: index root1 through a repo/indexer EXPLICITLY bound to
    // Database.layerFromRoot(root1) — no defaultLayer, no cwd involvement.
    const root1DbLayer = Database.layerFromRoot(root1)
    const indexerLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(CodegraphRepo.layer.pipe(Layer.provide(root1DbLayer))),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        yield* indexer.indexFiles({ root: root1, paths: [fileA] })
      }).pipe(
        Effect.provide(indexerLayer),
        // The indexer layer also consumes Database.Service directly (not just
        // through the repo); bind it to the same root DB, mirroring the
        // existing session tests in this file.
        Effect.provide(root1DbLayer),
        Effect.scoped,
      ),
    )

    const originalCwd = process.cwd
    try {
      // "Restart" the server from a different working directory. The old
      // Database.path() would hash this directory and open a DIFFERENT file.
      Object.defineProperty(process, "cwd", {
        value: () => root2,
        configurable: true,
      })
      expect(Database.path()).not.toBe(identity1.dbPath)

      // Session 2: reopen the SAME root-bound dbPath from the new cwd.
      const reopenLayer = CodegraphRepo.layer.pipe(Layer.provide(Database.layerFromRoot(root1)))
      const meta = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          return yield* repo.getMeta()
        }).pipe(Effect.provide(reopenLayer), Effect.scoped),
      )
      expect(meta).toBeDefined()
      expect(meta!.indexedRoot).toBe(identity1.root)
      expect(meta!.graphBuiltAt).toBeGreaterThan(0)

      // Isolation: a genuinely different workspace root has its own DB.
      const otherLayer = CodegraphRepo.layer.pipe(Layer.provide(Database.layerFromRoot(root2)))
      const otherMeta = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          return yield* repo.getMeta()
        }).pipe(Effect.provide(otherLayer), Effect.scoped),
      )
      expect(otherMeta).toBeUndefined()
    } finally {
      Object.defineProperty(process, "cwd", {
        value: originalCwd,
        configurable: true,
      })
    }
  })
})

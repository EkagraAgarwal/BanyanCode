import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "../../src/database/database"
import { LspInvalidationRepo } from "../../src/banyancode/lsp-invalidation-repo"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const buildLayer = (dbPath: string) =>
  LspInvalidationRepo.defaultLayer.pipe(Layer.provide(Database.layerFromPath(dbPath)))

describe("LspInvalidationRepo", () => {
  test("recordEvent inserts a row and returns its id", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const repo = yield* LspInvalidationRepo.Service
      const first = yield* repo.recordEvent({
        kind: "file_changed",
        path: "/tmp/a.ts",
        payload: { source: "test" },
      })
      const second = yield* repo.recordEvent({
        kind: "file_deleted",
        path: "/tmp/b.ts",
      })
      expect(typeof first.id).toBe("number")
      expect(typeof second.id).toBe("number")
      expect(second.id).toBeGreaterThan(first.id)
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("claimUnconsumed returns only unconsumed rows ordered by id", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const repo = yield* LspInvalidationRepo.Service
      const a = yield* repo.recordEvent({ kind: "file_changed", path: "/tmp/a.ts" })
      const b = yield* repo.recordEvent({ kind: "file_changed", path: "/tmp/b.ts" })
      const c = yield* repo.recordEvent({ kind: "file_deleted", path: "/tmp/c.ts" })

      yield* repo.markConsumed([b.id])

      const claimed = yield* repo.claimUnconsumed({ limit: 50 })
      const ids = claimed.map((e) => e.id)
      expect(ids).toContain(a.id)
      expect(ids).not.toContain(b.id)
      expect(ids).toContain(c.id)
      expect(ids[0]).toBe(a.id)
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("markConsumed is atomic across multiple ids and idempotent on redelivery", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const repo = yield* LspInvalidationRepo.Service
      const a = yield* repo.recordEvent({ kind: "file_changed", path: "/tmp/a.ts" })
      const b = yield* repo.recordEvent({ kind: "file_changed", path: "/tmp/b.ts" })
      const c = yield* repo.recordEvent({ kind: "file_changed", path: "/tmp/c.ts" })

      // Mark consumed in a single transaction; one redelivery must be a no-op.
      yield* repo.markConsumed([a.id, b.id, c.id])
      yield* repo.markConsumed([a.id, b.id, c.id])

      const unconsumed = yield* repo.claimUnconsumed({ limit: 50 })
      expect(unconsumed).toHaveLength(0)
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("markConsumed leaves other rows untouched (no cross-contamination)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const repo = yield* LspInvalidationRepo.Service
      const a = yield* repo.recordEvent({ kind: "file_changed", path: "/tmp/a.ts" })
      const b = yield* repo.recordEvent({ kind: "file_changed", path: "/tmp/b.ts" })

      yield* repo.markConsumed([a.id])

      const claimed = yield* repo.claimUnconsumed({ limit: 50 })
      expect(claimed.map((e) => e.id)).toEqual([b.id])
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("listRecent returns events in reverse insertion order with a limit", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const repo = yield* LspInvalidationRepo.Service
      for (let i = 0; i < 5; i++) {
        yield* repo.recordEvent({ kind: "file_changed", path: `/tmp/file-${i}.ts` })
      }

      const recent = yield* repo.listRecent(3)
      expect(recent).toHaveLength(3)
      // Newest first.
      const paths = recent.map((e) => e.path)
      expect(paths[0]).toBe("/tmp/file-4.ts")
      expect(paths[2]).toBe("/tmp/file-2.ts")
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("payload is preserved on read", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const repo = yield* LspInvalidationRepo.Service
      yield* repo.recordEvent({
        kind: "rebuilt",
        path: "/tmp/graph.json",
        payload: { nodes: 42, edges: 100 },
      })
      const recent = yield* repo.listRecent(1)
      expect(recent).toHaveLength(1)
      expect(recent[0].payload).toEqual({ nodes: 42, edges: 100 })
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("markConsumed on empty ids is a no-op", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const repo = yield* LspInvalidationRepo.Service
      yield* repo.markConsumed([])
      const claimed = yield* repo.claimUnconsumed({ limit: 10 })
      expect(claimed).toHaveLength(0)
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })
})

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import path from "node:path"
import { mkdirSync } from "node:fs"
import { LspFreshnessService, layer as freshnessLayer } from "@opencode-ai/core/lsp/lsp-freshness-service"
import { LspInvalidationRepo, layer as invalidationLayer } from "@opencode-ai/core/banyancode/lsp-invalidation-repo"
import { EventV2 } from "@opencode-ai/core/event"

// Phase 7 follow-up: deterministic acceptance test for the LSP
// freshness service. Per the plan, we exercise the lifecycle through
// the public `invalidate` path rather than the native Parcel watcher
// (which has a known crash on Windows in test environments). The
// observable behavior is identical: the public stream emits
// file-level events, the `listRecent` snapshot reflects the same
// events, and `markConsumed` updates the DB atomically.

process.env.BANYANCODE_ENABLE = "1"

const DEFAULT_LAYER = freshnessLayer.pipe(
  Layer.provide(invalidationLayer),
  Layer.provide(EventV2.defaultLayer),
  // freshness layer needs DB to be reachable
  Layer.provide(Layer.succeed(Database.Service, {} as never)),
)

describe("LspFreshnessService (deterministic via invalidate path)", () => {
  test("start + invalidate + listRecent reflect each event", async () => {
    await using tmp = await tmpdir()
    mkdirSync(path.join(tmp.path, ".banyancode"), { recursive: true })
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    // The real DB-backed invalidation repo
    const realInvalidationRepoLayer = invalidationLayer.pipe(Layer.provide(dbLayer))

    // Freshness service uses the real invalidation repo + a DB layer
    // it never directly accesses (the freshness repo wraps the same DB).
    const freshnessServiceLayer = freshnessLayer.pipe(
      Layer.provide(realInvalidationRepoLayer),
      Layer.provide(dbLayer),
      Layer.provide(EventV2.defaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* LspFreshnessService.Service
        yield* svc.start(tmp.path)
        const running = yield* svc.isRunning()
        expect(running).toBe(true)

        const status = yield* svc.status()
        expect(status.running).toBe(true)
        expect(status.root).toBe(tmp.path)

        // Use a unique tag so the snapshot can be filtered past the
        // Parcel watcher events that fire on the test root.
        const uniqueTag = `LSP-FRESHNESS-TEST-A-${Date.now()}-${Math.random().toString(36).slice(2)}`
        yield* svc.invalidate({ kind: "file_changed", path: `${uniqueTag}/foo.ts` })
        yield* svc.invalidate({ kind: "file_deleted", path: `${uniqueTag}/bar.ts` })
        yield* svc.invalidate({ kind: "indexed", path: `${uniqueTag}/baz.ts` })

        const recent = yield* svc.listRecent(100)
        const filtered = recent.filter((e) => e.path.startsWith(`${uniqueTag}/`))
        expect(filtered.length).toBe(3)
        expect(filtered.map((e) => e.path).sort()).toEqual([
          `${uniqueTag}/bar.ts`,
          `${uniqueTag}/baz.ts`,
          `${uniqueTag}/foo.ts`,
        ])

        yield* svc.stop()
        const stillRunning = yield* svc.isRunning()
        expect(stillRunning).toBe(false)
      }).pipe(Effect.provide(freshnessServiceLayer), Effect.scoped),
    )
  })

  test("markConsumed updates the persisted event row", async () => {
    await using tmp = await tmpdir()
    mkdirSync(path.join(tmp.path, ".banyancode"), { recursive: true })
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const realInvalidationRepoLayer = invalidationLayer.pipe(Layer.provide(dbLayer))
    const freshnessServiceLayer = freshnessLayer.pipe(
      Layer.provide(realInvalidationRepoLayer),
      Layer.provide(dbLayer),
      Layer.provide(EventV2.defaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* LspFreshnessService.Service
        yield* svc.start(tmp.path)
        // Unique tag so the snapshot can be filtered past the Parcel
        // watcher events that fire on the test root.
        const uniqueTag = `MARKTEST-${Date.now()}-${Math.random().toString(36).slice(2)}`
        yield* svc.invalidate({ kind: "file_changed", path: `${uniqueTag}/foo.ts` })
        yield* svc.invalidate({ kind: "file_changed", path: `${uniqueTag}/bar.ts` })

        const before = yield* svc.listRecent(100)
        const filtered = before.filter((e) => e.path.startsWith(`${uniqueTag}/`))
        expect(filtered.length).toBe(2)
        expect(filtered.every((e) => e.consumedAt === null)).toBe(true)

        yield* svc.markConsumed([filtered[0].id])

        const after = yield* svc.listRecent(100)
        const consumed = after.find((e) => e.id === filtered[0].id)
        const stillUnconsumed = after.find((e) => e.id === filtered[1].id)
        expect(consumed?.consumedAt).not.toBeNull()
        expect(stillUnconsumed?.consumedAt).toBeNull()

        yield* svc.stop()
      }).pipe(Effect.provide(freshnessServiceLayer), Effect.scoped),
    )
  })

  test("start with same root is idempotent; start with different root replaces", async () => {
    await using tmp = await tmpdir()
    mkdirSync(path.join(tmp.path, ".banyancode"), { recursive: true })
    const rootA = path.join(tmp.path, "a")
    const rootB = path.join(tmp.path, "b")
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const realInvalidationRepoLayer = invalidationLayer.pipe(Layer.provide(dbLayer))
    const freshnessServiceLayer = freshnessLayer.pipe(
      Layer.provide(realInvalidationRepoLayer),
      Layer.provide(dbLayer),
      Layer.provide(EventV2.defaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* LspFreshnessService.Service

        yield* svc.start(rootA)
        const statusA = yield* svc.status()
        expect(statusA.root).toBe(rootA)

        // Starting with the same root is a no-op
        yield* svc.start(rootA)
        const statusA2 = yield* svc.status()
        expect(statusA2.root).toBe(rootA)

        // Starting with a different root should replace
        yield* svc.start(rootB)
        const statusB = yield* svc.status()
        expect(statusB.root).toBe(rootB)

        yield* svc.stop()
      }).pipe(Effect.provide(freshnessServiceLayer), Effect.scoped),
    )
  })
})

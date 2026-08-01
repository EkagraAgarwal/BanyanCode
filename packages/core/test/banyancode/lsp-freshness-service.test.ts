import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { Database } from "../../src/database/database"
import { LspFreshnessService } from "../../src/lsp/lsp-freshness-service"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const buildLayer = (dbPath: string) =>
  LspFreshnessService.defaultLayer.pipe(Layer.provide(Database.layerFromPath(dbPath)))

type FreshnessEvent = { kind: "file_changed" | "file_deleted"; path: string }

describe("LspFreshnessService", () => {
  test("start activates the watcher and stop deactivates it", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const svc = yield* LspFreshnessService.Service
      expect(yield* svc.isRunning()).toBe(false)

      yield* svc.start(tmp.path)
      expect(yield* svc.isRunning()).toBe(true)
      const status = yield* svc.status()
      expect(status.running).toBe(true)
      expect(status.root).toBe(tmp.path)

      yield* svc.stop()
      expect(yield* svc.isRunning()).toBe(false)
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("invalidate records an event row and emits to the public stream", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const svc = yield* LspFreshnessService.Service
      yield* svc.start(tmp.path)

      const stream = svc.events()
      const deferred = yield* Deferred.make<FreshnessEvent>()

      // The service uses a single drain fiber internally; this stream is
      // the public consumer surface. Use runForEach via the stream directly
      // (the service's events() returns a Stream.fromQueue of the public
      // queue, which is already a fully-typed Stream — Stream.fromQueue's
      // issue is only when constructed via Queue.Dequeue directly).
      const fiber = yield* Effect.forkScoped(
        stream.pipe(
          Stream.runForEach((event) =>
            Deferred.succeed(deferred, event).pipe(Effect.as(Effect.void)),
          ),
        ),
      )

      yield* Effect.sleep("100 millis")

      yield* svc.invalidate({
        kind: "file_changed",
        path: path.join(tmp.path, "manual.ts"),
        payload: { source: "test" },
      })

      const seenOption = yield* Deferred.await(deferred).pipe(Effect.timeoutOption("3 seconds"))

      yield* Fiber.interrupt(fiber)
      yield* svc.stop()

      expect(seenOption._tag).toBe("Some")
      const event = (seenOption as { value: FreshnessEvent }).value
      expect(event.kind).toBe("file_changed")
      expect(event.path.endsWith("manual.ts")).toBe(true)

      const recent = yield* svc.listRecent(10)
      expect(recent.some((e) => e.path.endsWith("manual.ts"))).toBe(true)
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer), Effect.scoped)

    await Effect.runPromise(program)
  })

  test("starting with the same root twice is a no-op", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const svc = yield* LspFreshnessService.Service
      yield* svc.start(tmp.path)
      const firstStatus = yield* svc.status()

      yield* svc.start(tmp.path)
      const secondStatus = yield* svc.status()

      expect(secondStatus.startedAt).toBe(firstStatus.startedAt)

      yield* svc.stop()
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("events stream ends after stop()", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const svc = yield* LspFreshnessService.Service
      yield* svc.start(tmp.path)
      yield* svc.stop()

      const chunks = yield* svc.events().pipe(Stream.runCollect)
      expect(Array.from(chunks)).toEqual([])
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("markConsumed stamps the consumed_at column on rows", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const svc = yield* LspFreshnessService.Service
      yield* svc.start(tmp.path)

      yield* svc.invalidate({
        kind: "file_changed",
        path: path.join(tmp.path, "x.ts"),
      })
      yield* svc.invalidate({
        kind: "file_changed",
        path: path.join(tmp.path, "y.ts"),
      })

      const beforeClaim = yield* svc.listRecent(10)
      yield* svc.markConsumed(beforeClaim.map((e) => e.id))

      const afterRecent = yield* svc.listRecent(10)
      expect(afterRecent.every((e) => e.consumedAt !== null)).toBe(true)

      yield* svc.stop()
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })
})

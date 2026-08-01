import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Queue } from "effect"
import path from "node:path"
import { startLspFreshnessWatcher, lspWatcherBackendAvailable } from "../../src/lsp/lsp-freshness-watcher"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

type LspEvent = { kind: string; path: string; type?: string }

const describeWatcher = lspWatcherBackendAvailable() ? describe : describe.skip

describeWatcher("lsp-freshness-watcher (live)", () => {
  test("emits a file_changed event after a new file is written", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path

    const program = Effect.gen(function* () {
      const { handle, events } = yield* startLspFreshnessWatcher(root)

      const target = path.join(root, "sample.ts")
      const deferred = yield* Deferred.make<LspEvent>()

      // Use Queue.take (the canonical pattern from system-monitor.test.ts) to
      // drain the underlying Dequeue. Stream.fromQueue + Stream.take has a
      // known issue with Effect v4 beta's internal Channel.
      const fiber = yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const event = (yield* Queue.take(events)) as LspEvent
            if (event.kind === "change" && event.path === target) {
              yield* Deferred.succeed(deferred, event)
            }
          }),
        ),
      )

      // Wait for the watcher to subscribe.
      yield* Effect.sleep("300 millis")

      // Trigger AFTER the subscription is wired so we don't miss the event.
      yield* Effect.promise(() => Bun.write(target, "export const x = 1\n"))

      const seenOption = yield* Deferred.await(deferred).pipe(Effect.timeoutOption("8 seconds"))

      yield* Fiber.interrupt(fiber)
      yield* handle.stop()

      expect(seenOption._tag).toBe("Some")
      const event = (seenOption as { value: LspEvent }).value
      expect(event.kind).toBe("change")
      expect(event.path).toBe(target)
      expect(["add", "change"]).toContain(event.type ?? "change")
    }).pipe(Effect.scoped)

    await Effect.runPromise(program)
  }, 15000)

  test("emits a file_changed event for an existing file's content update", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path

    const program = Effect.gen(function* () {
      const { handle, events } = yield* startLspFreshnessWatcher(root)

      const target = path.join(root, "existing.ts")
      // Seed the file before subscribing so we observe the change event.
      yield* Effect.promise(() => Bun.write(target, "v1"))

      yield* Effect.sleep("300 millis")

      const deferred = yield* Deferred.make<LspEvent>()
      const fiber = yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const event = (yield* Queue.take(events)) as LspEvent
            if (event.kind === "change" && event.path === target) {
              yield* Deferred.succeed(deferred, event)
            }
          }),
        ),
      )

      yield* Effect.promise(() => Bun.write(target, "v2"))

      const seenOption = yield* Deferred.await(deferred).pipe(Effect.timeoutOption("8 seconds"))

      yield* Fiber.interrupt(fiber)
      yield* handle.stop()

      expect(seenOption._tag).toBe("Some")
      const event = (seenOption as { value: LspEvent }).value
      expect(event.kind).toBe("change")
      expect(event.path).toBe(target)
    }).pipe(Effect.scoped)

    await Effect.runPromise(program)
  }, 15000)
})

describe("lsp-freshness-watcher (graceful degradation)", () => {
  test("stop() is a no-op when the native binding is unavailable", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path

    const program = Effect.gen(function* () {
      const { handle } = yield* startLspFreshnessWatcher(root)
      yield* handle.stop()
    })

    await Effect.runPromise(program)
  })
})

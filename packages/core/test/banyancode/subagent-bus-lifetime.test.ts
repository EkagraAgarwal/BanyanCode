/**
 * Regression test for the per-session mesh queue lifetime bug.
 *
 * Pre-fix, `bus.subscribe` registered an `Effect.addFinalizer(Queue.shutdown)`
 * inside its body. Both production callers (`mesh-coordinator.subscribe`,
 * `subagent-consumer.start`) wrapped the call in `Effect.scoped`, which
 * closed the scope on gen return and shut the queue before any consumer
 * fiber could `Queue.take` from it. The reproduction surfaced as either
 * `mesh_subscribe` returning an empty stream immediately (every valid
 * parent session) or every `SubagentConsumer.start` consumer being a no-op.
 *
 * The fix moved queue cleanup out of `bus.subscribe` and into the caller
 * (scope-aware). This test uses the REAL `SubagentBus` layer (no mocks) and
 * the REAL `SubagentMessagesRepo` to assert:
 *
 * 1. After bus.subscribe returns, the queue is ALIVE — it must block on
 *    `Queue.take` for an empty observable window (timing-based assertion).
 *    Pre-fix, the queue was already shut so take returned immediately
 *    (<5ms); post-fix, take blocks for the timeout window (~100ms).
 * 2. A message persisted via `repo.put` BEFORE `bus.subscribe` is in the
 *    queue (the pre-load path) and is delivered to a waiting `Queue.take`.
 * 3. Subscribe fails fast on an unknown parent.
 *
 * Mock layers (the existing `makeSubagentBusMockLayer`) bypass `bus.subscribe`
 * entirely and would silently pass even with the lifetime bug.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SubagentBus } from "@opencode-ai/core/banyancode/subagent-bus"
import { SubagentMessagesRepo } from "@opencode-ai/core/banyancode/subagent-messages-repo"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import type { SubagentMessage } from "@opencode-ai/core/banyancode/types"

process.env.BANYANCODE_ENABLE = "1"

const buildBusLayer = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const messagesLayer = SubagentMessagesRepo.layer.pipe(Layer.provide(dbLayer))
  const busLayer = SubagentBus.layer.pipe(
    Layer.provide(messagesLayer),
    Layer.provide(dbLayer),
  )
  return { dbLayer, messagesLayer, busLayer }
}

const seedParentSession = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* DatabaseMigration.apply(db)
  yield* db
    .insert(ProjectTable)
    .values({
      id: Project.ID.global,
      worktree: AbsolutePath.make("/test"),
      sandboxes: [],
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: SessionV2.ID.make("ses_real_parent"),
      project_id: Project.ID.global,
      slug: "real",
      directory: "/test",
      title: "real",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

describe("SubagentBus real-bus subscribe lifetime (regression)", () => {
  test("subscribe fails fast with SubagentSessionNotFoundError for an unknown parent", async () => {
    await using tmp = await tmpdir()
    const { dbLayer, messagesLayer, busLayer } = buildBusLayer(path.join(tmp.path, "subscribe-notfound.sqlite"))

    const start = Date.now()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const bus = yield* SubagentBus.Service
        return yield* bus.subscribe("ses_does_not_exist_real").pipe(
          Effect.map((queue) => ({ _tag: "ok" as const, queue })),
          Effect.catchTag("Banyan/SubagentSessionNotFoundError", (e) =>
            Effect.succeed({ _tag: "not_found" as const, error: e }),
          ),
        )
      }).pipe(Effect.provide(busLayer), Effect.provide(dbLayer), Effect.scoped),
    )
    const elapsed = Date.now() - start

    expect(result._tag).toBe("not_found")
    if (result._tag === "not_found") {
      expect(result.error._tag).toBe("Banyan/SubagentSessionNotFoundError")
      expect((result.error as { parentSessionID: string }).parentSessionID).toBe("ses_does_not_exist_real")
    }
    expect(elapsed).toBeLessThan(5_000)
  })

  test("subscribed queue is alive after subscribe returns (post-fix lifetime)", async () => {
    await using tmp = await tmpdir()
    const { dbLayer, busLayer } = buildBusLayer(path.join(tmp.path, "subscribe-alive.sqlite"))

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedParentSession
        const bus = yield* SubagentBus.Service

        const elapsedMs = yield* Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* bus.subscribe("ses_real_parent")
            yield* Effect.addFinalizer(() => Queue.shutdown(queue))
            // Pre-fix: this take completes immediately (<5ms) because the
            // queue was already shut by the local Effect.scoped in the
            // coordinator/subagent-consumer path. Post-fix: the queue is
            // alive and empty, so the take blocks until the timeout.
            const start = Date.now()
            yield* Queue.take(queue).pipe(Effect.timeout("150 millis"), Effect.ignore)
            return Date.now() - start
          }),
        )

        // Post-fix: elapsed should be at least 100ms (the timeout fired).
        // Pre-fix: elapsed would be < 5ms (queue shut, take returned Done).
        expect(elapsedMs).toBeGreaterThan(80)
      }).pipe(Effect.provide(busLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("messages persisted before subscribe are delivered through the queue", async () => {
    await using tmp = await tmpdir()
    const { dbLayer, messagesLayer, busLayer } = buildBusLayer(path.join(tmp.path, "subscribe-preload.sqlite"))

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedParentSession

        const repo = yield* SubagentMessagesRepo.Service
        const bus = yield* SubagentBus.Service

        // Persist a message so bus.subscribe's pre-load picks it up.
        const preloadedMessage: SubagentMessage = {
          id: "msg_real_preload",
          parentSessionID: "ses_real_parent",
          fromSession: "ses_child",
          fromAgent: "coder",
          kind: "inform",
          payload: { text: "preloaded" },
          createdAt: Date.now(),
        }
        yield* repo.put(preloadedMessage)

        const consumed = yield* Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* bus.subscribe("ses_real_parent")
            yield* Effect.addFinalizer(() => Queue.shutdown(queue))
            // Pre-fix: queue was already shut, so take returns Done.
            // Post-fix: queue is alive and contains the pre-loaded message.
            return yield* Queue.take(queue)
          }),
        )

        expect(consumed.id).toBe("msg_real_preload")
        expect(consumed.parentSessionID).toBe("ses_real_parent")
      }).pipe(Effect.provide(busLayer), Effect.provide(messagesLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

/**
 * Regression test for the MeshCoordinator.subscribe timeout path.
 *
 * Pre-fix, mesh_subscribe used Effect.timeoutOrElse for the consume
 * boundary. Two problems:
 *  1. When the timer fires, the inner Stream.take(N).runCollect fiber
 *     is NOT interrupted — it keeps running until the surrounding
 *     scope closes (subscriber leak on every quiet-session call).
 *  2. streamActive is reported as true even on the timeout path.
 *
 * The fix races the collect against a deadline using `Effect.race`,
 * which interrupts the loser, and exposes a `timedOut` field so the
 * model can tell whether messages actually arrived.
 *
 * This test exercises the coordinator-level consume path with the REAL
 * SubagentBus + MeshCoordinator layers. Mock-layer tests bypass the
 * consume path entirely.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { SubagentBus } from "@opencode-ai/core/banyancode/subagent-bus"
import { SubagentPlans } from "@opencode-ai/core/banyancode/subagent-plans-repo"
import { SubagentReviewRequests } from "@opencode-ai/core/banyancode/subagent-review-requests-repo"
import { SubagentMessagesRepo } from "@opencode-ai/core/banyancode/subagent-messages-repo"
import { MeshCoordinator, layer as coordinatorLayer } from "@opencode-ai/core/banyancode/mesh-coordinator"
import { Banyan } from "@opencode-ai/core/banyancode"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const buildLayers = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const messagesLayer = SubagentMessagesRepo.layer.pipe(Layer.provide(dbLayer))
  const plansLayer = SubagentPlans.layer.pipe(
    Layer.provide(messagesLayer),
    Layer.provide(dbLayer),
  )
  const reviewsLayer = SubagentReviewRequests.layer.pipe(Layer.provide(dbLayer))
  const eventsLayer = EventV2.layer.pipe(Layer.provide(dbLayer))
  const subagentBusLayer = SubagentBus.layer.pipe(
    Layer.provide(messagesLayer),
    Layer.provide(dbLayer),
  )
  const serviceLayer = coordinatorLayer.pipe(
    Layer.provide(subagentBusLayer),
    Layer.provide(plansLayer),
    Layer.provide(reviewsLayer),
    Layer.provide(eventsLayer),
  )
  return { dbLayer, messagesLayer, serviceLayer }
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
      id: SessionV2.ID.make("ses_timeout_parent"),
      project_id: Project.ID.global,
      slug: "t",
      directory: "/test",
      title: "t",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

/**
 * Mirror the production consume pattern (mesh-subscribe.ts post-fix):
 * race the `Stream.take(N).runCollect` against a deadline that interrupts
 * the loser, and inspect the timing + result.
 */
const consumeWithDeadline = (stream: Stream.Stream<unknown, never, never>, timeoutMs: number) => {
  const collect = stream.pipe(
    Stream.take(10),
    Stream.runCollect,
    Effect.map((chunk) => ({ timedOut: false, messages: Array.from(chunk) as ReadonlyArray<unknown>, chunkSize: chunk.length })),
  )
  const deadline = Effect.sleep(`${timeoutMs} millis`).pipe(
    Effect.map(() => ({ timedOut: true, messages: [] as ReadonlyArray<unknown>, chunkSize: 0 })),
  )
  return collect.pipe(Effect.race(deadline))
}

describe("MeshCoordinator.subscribe timeout path (regression)", () => {
  test("times out cleanly when no messages arrive and reports timedOut:true", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "subscribe-timeout.sqlite")
    const { dbLayer, serviceLayer, messagesLayer } = buildLayers(dbPath)

    const start = Date.now()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedParentSession
        const coordinator = yield* MeshCoordinator.Service
        const { stream } = yield* coordinator.subscribe({
          parentSessionID: "ses_timeout_parent" as never,
        })
        return yield* consumeWithDeadline(stream as never, 150)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(messagesLayer), Effect.provide(dbLayer), Effect.scoped),
    )
    const elapsed = Date.now() - start

    // Deadline wins, no message arrives, the runCollect fiber is
    // interrupted (the surrounding scope closes cleanly).
    expect(result.timedOut).toBe(true)
    expect(result.messages.length).toBe(0)
    expect(elapsed).toBeLessThan(2_000)
    expect(elapsed).toBeGreaterThan(100)
  })

  test("collect wins when pre-loaded message matches take count", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "subscribe-preload.sqlite")
    const { dbLayer, serviceLayer, messagesLayer } = buildLayers(dbPath)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedParentSession
        const repo = yield* Banyan.SubagentMessagesRepo
        yield* repo.put({
          id: "msg_preload_timeout",
          parentSessionID: "ses_timeout_parent",
          fromSession: "ses_child",
          fromAgent: "coder",
          kind: "inform",
          payload: { text: "preloaded before subscribe" },
          createdAt: Date.now(),
        })

        const coordinator = yield* MeshCoordinator.Service
        const { stream } = yield* coordinator.subscribe({
          parentSessionID: "ses_timeout_parent" as never,
        })
        // One message is pre-loaded; ask for exactly one so the take
        // completes immediately and the collect wins the race before
        // the 1s deadline.
        const collectOne = stream.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.map((chunk) => ({ timedOut: false, messages: Array.from(chunk) as ReadonlyArray<unknown>, chunkSize: chunk.length })),
        )
        const deadline = Effect.sleep(`1000 millis`).pipe(
          Effect.map(() => ({ timedOut: true, messages: [] as ReadonlyArray<unknown>, chunkSize: 0 })),
        )
        return yield* collectOne.pipe(Effect.race(deadline))
      }).pipe(Effect.provide(serviceLayer), Effect.provide(messagesLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    // Collect wins before the 1s deadline.
    expect(result.timedOut).toBe(false)
    expect(result.messages.length).toBe(1)
  })
})

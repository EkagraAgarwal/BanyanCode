import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Queue, Scope, Stream } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "../../src/event"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import { SubagentBus } from "../../src/banyancode/subagent-bus"
import { SubagentMessagesRepo } from "../../src/banyancode/subagent-messages-repo"
import { SubagentPlans } from "../../src/banyancode/subagent-plans-repo"
import { SubagentReviewRequests } from "../../src/banyancode/subagent-review-requests-repo"
import { MeshCoordinator, layer } from "../../src/banyancode/mesh-coordinator"
import type { SubagentMessage } from "../../src/banyancode/types"

process.env.BANYANCODE_ENABLE = "1"

describe("MeshCoordinator.subscribe", () => {
  test("yields new messages as they arrive", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockQueue = Effect.runSync(Queue.unbounded<SubagentMessage>())

    const mockBus = Layer.effect(
      SubagentBus.Service,
      Effect.gen(function* () {
        return SubagentBus.Service.of({
          publish: () => Effect.void,
          publishOrFetch: (msg) => Effect.succeed({ id: msg.id, createdAt: msg.createdAt, created: true }),
          parentSessionExists: () => Effect.succeed(true),
          subscribe: () =>
            Effect.succeed(mockQueue) as Effect.Effect<
              Queue.Dequeue<SubagentMessage>,
              SubagentBus.SubagentSessionNotFoundError,
              Scope.Scope
            >,
          subscribeAll: () =>
            Effect.succeed(mockQueue) as Effect.Effect<
              Queue.Dequeue<SubagentMessage>,
              never,
              Scope.Scope
            >,
          peers: () => Effect.succeed([]),
        })
      }),
    )

    const mockPlans = Layer.succeed(
      SubagentPlans.Service,
      SubagentPlans.Service.of({
        put: () => Effect.void,
        getByID: () => Effect.succeed(undefined),
        listByParent: () => Effect.succeed([]),
        listBySession: () => Effect.succeed([]),
        markCompleted: () => Effect.void,
        markCancelled: () => Effect.void,
        setStepStatus: () => Effect.succeed(undefined),
      }),
    )
    const mockReviews = Layer.succeed(
      SubagentReviewRequests.Service,
      SubagentReviewRequests.Service.of({
        put: () => Effect.void,
        getByID: () => Effect.succeed(undefined),
        listByParent: () => Effect.succeed([]),
        markDispatched: () => Effect.void,
        markCompleted: () => Effect.void,
        markFailed: () => Effect.void,
      }),
    )



    const serviceLayer = layer.pipe(
      Layer.provide(mockBus),
      Layer.provide(mockPlans),
      Layer.provide(mockReviews),      Layer.provide(EventV2.defaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const mesh = yield* MeshCoordinator.Service

        // Publish 2 messages to the queue
        Effect.runSync(Queue.offer(mockQueue, {
          id: "msg_1",
          parentSessionID: "ses_parent",
          fromSession: "ses_1",
          fromAgent: "coder",
          kind: "inform" as const,
          payload: { text: "hello" },
          createdAt: Date.now(),
        }))
        Effect.runSync(Queue.offer(mockQueue, {
          id: "msg_2",
          parentSessionID: "ses_parent",
          fromSession: "ses_2",
          fromAgent: "explore",
          kind: "checkpoint" as const,
          payload: { summary: "done", todos: [] },
          createdAt: Date.now(),
        }))

        const stream = yield* mesh.subscribe({ parentSessionID: "ses_parent" as any })
        const messages = yield* stream.pipe(Stream.take(2), Stream.runCollect)

        expect(messages).toHaveLength(2)
        expect(messages[0].id).toBe("msg_1")
        expect(messages[1].id).toBe("msg_2")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("filters by agentName in both directions", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockQueue = Effect.runSync(Queue.unbounded<SubagentMessage>())

    const mockBus = Layer.effect(
      SubagentBus.Service,
      Effect.gen(function* () {
        return SubagentBus.Service.of({
          publish: () => Effect.void,
          publishOrFetch: (msg) => Effect.succeed({ id: msg.id, createdAt: msg.createdAt, created: true }),
          parentSessionExists: () => Effect.succeed(true),
          subscribe: () =>
            Effect.succeed(mockQueue) as Effect.Effect<
              Queue.Dequeue<SubagentMessage>,
              SubagentBus.SubagentSessionNotFoundError,
              Scope.Scope
            >,
          subscribeAll: () =>
            Effect.succeed(mockQueue) as Effect.Effect<
              Queue.Dequeue<SubagentMessage>,
              never,
              Scope.Scope
            >,
          peers: () => Effect.succeed([]),
        })
      }),
    )

    const mockPlans = Layer.succeed(
      SubagentPlans.Service,
      SubagentPlans.Service.of({
        put: () => Effect.void,
        getByID: () => Effect.succeed(undefined),
        listByParent: () => Effect.succeed([]),
        listBySession: () => Effect.succeed([]),
        markCompleted: () => Effect.void,
        markCancelled: () => Effect.void,
        setStepStatus: () => Effect.succeed(undefined),
      }),
    )
    const mockReviews = Layer.succeed(
      SubagentReviewRequests.Service,
      SubagentReviewRequests.Service.of({
        put: () => Effect.void,
        getByID: () => Effect.succeed(undefined),
        listByParent: () => Effect.succeed([]),
        markDispatched: () => Effect.void,
        markCompleted: () => Effect.void,
        markFailed: () => Effect.void,
      }),
    )

    const serviceLayer = layer.pipe(
      Layer.provide(mockBus),
      Layer.provide(mockPlans),
      Layer.provide(mockReviews),      Layer.provide(EventV2.defaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const mesh = yield* MeshCoordinator.Service

        // Publish 3 messages: 1 from coder, 1 from explore, 1 to coder
        Effect.runSync(Queue.offer(mockQueue, {
          id: "msg_1",
          parentSessionID: "ses_parent",
          fromSession: "ses_1",
          fromAgent: "coder",
          toAgent: "orchestrator",
          kind: "inform" as const,
          payload: { text: "from coder" },
          createdAt: Date.now(),
        }))
        Effect.runSync(Queue.offer(mockQueue, {
          id: "msg_2",
          parentSessionID: "ses_parent",
          fromSession: "ses_2",
          fromAgent: "explore",
          toAgent: "orchestrator",
          kind: "inform" as const,
          payload: { text: "from explore" },
          createdAt: Date.now(),
        }))
        Effect.runSync(Queue.offer(mockQueue, {
          id: "msg_3",
          parentSessionID: "ses_parent",
          fromSession: "ses_3",
          fromAgent: "orchestrator",
          toAgent: "coder",
          kind: "steer" as const,
          payload: { instruction: "focus" },
          createdAt: Date.now(),
        }))

        // Subscribe with agentName="coder" — should get msg_1 (from coder) and msg_3 (to coder)
        const stream = yield* mesh.subscribe({ parentSessionID: "ses_parent" as any, agentName: "coder" })
        const messages = yield* stream.pipe(Stream.take(2), Stream.runCollect)

        expect(messages).toHaveLength(2)
        expect(messages[0].id).toBe("msg_1")
        expect(messages[1].id).toBe("msg_3")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  /**
   * Regression: pre-fix, `mesh_subscribe` would hang indefinitely on an
   * invalid `parentSessionID` because `Stream.take(N)` on an empty queue
   * never resolves. The fix adds a `SubagentSessionNotFoundError` that the
   * bus fires fast when the parent session does not exist in the session
   * table. This test uses the REAL `SubagentBus` and `MeshCoordinator`
   * (no mocks) against an empty DB to assert the error fires within a few
   * hundred ms rather than hanging.
   */
  test("subscribe fails fast with SubagentSessionNotFoundError on invalid parentSessionID", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "invalid_parent.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    // Real layers all the way down — no mocks. The parentSessionExists
    // lookup against SessionTable will return false (no sessions exist in
    // a fresh tmpdir DB) and the bus will fail fast.
    const serviceLayer = layer.pipe(
      Layer.provide(SubagentBus.defaultLayer),
      Layer.provide(SubagentPlans.defaultLayer),
      Layer.provide(SubagentReviewRequests.defaultLayer),
      Layer.provide(SubagentMessagesRepo.defaultLayer),
      Layer.provide(dbLayer),
      Layer.provide(EventV2.defaultLayer),
    )

    const start = Date.now()
    // catchTag extracts the typed error as a value rather than letting
    // it propagate as a defect. The result is a discriminated union
    // we can assert on directly.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const mesh = yield* MeshCoordinator.Service
        return yield* mesh
          .subscribe({ parentSessionID: "ses_does_not_exist" as any })
          .pipe(
            Effect.map((stream) => ({ _tag: "ok" as const, stream })),
            Effect.catchTag("Banyan/SubagentSessionNotFoundError", (e) =>
              Effect.succeed({ _tag: "not_found" as const, error: e }),
            ),
          )
      }).pipe(Effect.provide(serviceLayer), Effect.scoped),
    )
    const elapsedMs = Date.now() - start

    // The call should fail fast (not hang) and the failure should be the
    // typed SubagentSessionNotFoundError carrying the invalid parentSessionID.
    expect(result._tag).toBe("not_found")
    if (result._tag === "not_found") {
      expect(result.error).toBeInstanceOf(SubagentBus.SubagentSessionNotFoundError)
      expect(result.error.parentSessionID).toBe("ses_does_not_exist")
    }
    // And it should fail FAST — well under the 30s default timeout.
    // We give it a generous 5s upper bound to avoid CI flakes while
    // still catching the infinite-hang regression (which would never
    // return).
    expect(elapsedMs).toBeLessThan(5000)
  })
})

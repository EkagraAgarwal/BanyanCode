import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue, Stream } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "../../src/event"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import { SubagentBus } from "../../src/banyancode/subagent-bus"
import { SubagentPlans } from "../../src/banyancode/subagent-plans-repo"
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
          subscribe: () => Effect.succeed(mockQueue),
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
      }),
    )

    const serviceLayer = layer.pipe(
      Layer.provide(mockBus),
      Layer.provide(mockPlans),
      Layer.provide(EventV2.defaultLayer),
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
          subscribe: () => Effect.succeed(mockQueue),
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
      }),
    )

    const serviceLayer = layer.pipe(
      Layer.provide(mockBus),
      Layer.provide(mockPlans),
      Layer.provide(EventV2.defaultLayer),
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
})

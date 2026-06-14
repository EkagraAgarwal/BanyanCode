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

describe("MeshCoordinator", () => {
  test("checkin returns peers with last-seen time and checkpoint", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockPeers = [
      { sessionID: "ses_1", agent: "coder", status: "active" as const, lastSeenAt: Date.now() },
      { sessionID: "ses_2", agent: "explore", status: "active" as const, lastSeenAt: Date.now() },
    ]
    const mockMessages: SubagentMessage[] = [
      {
        id: "msg_1",
        parentSessionID: "ses_parent",
        fromSession: "ses_1",
        fromAgent: "coder",
        kind: "checkpoint",
        payload: { summary: "working on task", todos: [] },
        createdAt: Date.now(),
      },
    ]

    const mockBus = Layer.effect(
      SubagentBus.Service,
      Effect.gen(function* () {
        const q = yield* Queue.unbounded<SubagentMessage>()
        for (const m of mockMessages) yield* Queue.offer(q, m)
        return SubagentBus.Service.of({
          publish: () => Effect.void,
          subscribe: () => Effect.succeed(q),
          peers: () => Effect.succeed(mockPeers),
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
        const result = yield* mesh.checkin("ses_parent" as any)
        expect(result).toHaveLength(2)
        expect(result[0].agent).toBe("coder")
        expect(result[0].sessionID).toBe("ses_1")
        expect(result[0].lastCheckpoint?.summary).toBe("working on task")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("steer publishes a steer message to the bus", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    let publishedMessage: any = null

    const mockBus = Layer.effect(
      SubagentBus.Service,
      Effect.gen(function* () {
        const q = yield* Queue.unbounded<SubagentMessage>()
        return SubagentBus.Service.of({
          publish: (msg: any) => Effect.sync(() => { publishedMessage = msg }),
          subscribe: () => Effect.succeed(q),
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
        yield* mesh.steer({
          parentSessionID: "ses_parent" as any,
          targetAgent: "coder",
          instruction: "focus on tests",
          priority: "high",
        })
        expect(publishedMessage).not.toBeNull()
        expect(publishedMessage.kind).toBe("steer")
        expect(publishedMessage.toAgent).toBe("coder")
        expect(publishedMessage.payload).toEqual({ instruction: "focus on tests", priority: "high" })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("kill publishes a kill message", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    let publishedMessage: any = null

    const mockBus = Layer.effect(
      SubagentBus.Service,
      Effect.gen(function* () {
        const q = yield* Queue.unbounded<SubagentMessage>()
        return SubagentBus.Service.of({
          publish: (msg: any) => Effect.sync(() => { publishedMessage = msg }),
          subscribe: () => Effect.succeed(q),
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
        yield* mesh.kill({
          parentSessionID: "ses_parent" as any,
          targetAgent: "explore",
          reason: "task complete",
        })
        expect(publishedMessage).not.toBeNull()
        expect(publishedMessage.kind).toBe("kill")
        expect(publishedMessage.toAgent).toBe("explore")
        expect(publishedMessage.payload).toEqual({ reason: "task complete" })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("planFor publishes a plan message and persists to SubagentPlansRepo", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    let publishedMessage: any = null
    let persistedPlan: any = null

    const mockBus = Layer.effect(
      SubagentBus.Service,
      Effect.gen(function* () {
        const q = yield* Queue.unbounded<SubagentMessage>()
        return SubagentBus.Service.of({
          publish: (msg: any) => Effect.sync(() => { publishedMessage = msg }),
          subscribe: () => Effect.succeed(q),
          peers: () => Effect.succeed([]),
        })
      }),
    )

    const mockPlans = Layer.succeed(
      SubagentPlans.Service,
      SubagentPlans.Service.of({
        put: (plan: any) => Effect.sync(() => { persistedPlan = plan }),
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

    const testPlan = {
      title: "Implement feature X",
      steps: [
        { content: "write tests", status: "pending" as const },
        { content: "write code", status: "pending" as const },
      ],
      exitCriteria: "all tests pass",
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const mesh = yield* MeshCoordinator.Service
        yield* mesh.planFor({
          parentSessionID: "ses_parent" as any,
          targetAgent: "coder",
          plan: testPlan,
        })
        expect(publishedMessage).not.toBeNull()
        expect(publishedMessage.kind).toBe("plan")
        expect(publishedMessage.toAgent).toBe("coder")
        expect(publishedMessage.payload).toEqual(testPlan)

        expect(persistedPlan).not.toBeNull()
        expect(persistedPlan.title).toBe("Implement feature X")
        expect(persistedPlan.agent).toBe("coder")
        expect(persistedPlan.status).toBe("active")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("watch returns a stream with StatusUpdated event", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockBus = Layer.effect(
      SubagentBus.Service,
      Effect.gen(function* () {
        const q = yield* Queue.unbounded<SubagentMessage>()
        return SubagentBus.Service.of({
          publish: () => Effect.void,
          subscribe: () => Effect.succeed(q),
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
        const stream = yield* mesh.watch("ses_parent" as any)

        const items: any[] = []
        yield* Stream.runCollect(stream).pipe(
          Effect.map((collected: any[]) => { items.push(...collected) }),
        )

        expect(items.length).toBeGreaterThan(0)
        expect(items[0].parentSessionID).toBe("ses_parent")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
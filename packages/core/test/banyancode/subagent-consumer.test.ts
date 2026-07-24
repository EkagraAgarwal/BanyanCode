import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { SubagentConsumer, layer } from "../../src/banyancode/subagent-consumer"
import { SubagentBus } from "../../src/banyancode/subagent-bus"
import { MemoryRepo } from "../../src/banyancode/memory-repo"
import { SubagentMessagesRepo } from "../../src/banyancode/subagent-messages-repo"
import { MeshCoordinator } from "../../src/banyancode/mesh-coordinator"
import { SubagentPlans } from "../../src/banyancode/subagent-plans-repo"
import { EventV2 } from "../../src/event"
import { Database } from "../../src/database/database"
import { DatabaseMigration } from "../../src/database/migration"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import type { MemoryEntry, SubagentMessage } from "../../src/banyancode/types"

process.env.BANYANCODE_ENABLE = "1"

const buildServiceLayer = (dbPath: string, queue: Queue.Queue<SubagentMessage>, captured: MemoryEntry[]) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const messagesLayer = SubagentMessagesRepo.defaultLayer.pipe(Layer.provide(dbLayer))

  const mockBus = Layer.succeed(
    SubagentBus.Service,
    SubagentBus.Service.of({
      publish: () => Effect.void,
      publishOrFetch: (msg) => Effect.succeed({ id: msg.id, createdAt: msg.createdAt, created: true }),
      subscribe: () => Effect.succeed(queue),
      peers: () => Effect.succeed([]),
    }),
  )

  const mockMemory = Layer.succeed(
    MemoryRepo.Service,
    MemoryRepo.Service.of({
      put: (input) =>
        Effect.sync(() => {
          captured.push({
            id: input.id,
            key: input.key,
            value: input.value,
            tags: input.tags ?? [],
            scope: input.scope,
            sessionID: input.sessionID,
            createdAt: input.createdAt ?? Date.now(),
          } as MemoryEntry)
        }),
      get: () => Effect.succeed(undefined),
      list: () => Effect.succeed([]),
      forget: () => Effect.void,
      forgetByKey: () => Effect.succeed(0),
      search: () => Effect.succeed([]),
      searchRanked: () => Effect.succeed({ entries: [], totalHits: 0 }),
      vacuum: () => Effect.succeed(0),
      update: () => Effect.die("not used"),
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

  const mockMesh = Layer.succeed(
    MeshCoordinator.Service,
    MeshCoordinator.Service.of({
      status: () => Effect.die("not used"),
      trackParent: () => Effect.void,
      listTrackedParents: () => Effect.succeed([]),
      watch: () => Effect.die("not used"),
      subscribe: () => Effect.die("not used"),
      checkin: () => Effect.succeed([]),
      steer: () => Effect.void,
      kill: () => Effect.void,
      planFor: () => Effect.void,
      tryReserveSubagentSlot: () => Effect.succeed({ ok: true, killed: null }),
      registerConsumer: () => Effect.void,
      unregisterConsumer: () => Effect.void,
      runGarbageCollection: () => Effect.succeed({ swept: 0, interrupted: 0 }),
      markParentEnded: () => Effect.void,
    }),
  )

  return layer.pipe(
    Layer.provide(mockBus),
    Layer.provide(mockMemory),
    Layer.provide(messagesLayer),
    Layer.provide(mockPlans),
    Layer.provide(mockMesh),
  )
}

describe("SubagentConsumer", () => {
  test("start forks the loop and the loop processes a plan message into memory", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const queue = await Effect.runPromise(Queue.unbounded<SubagentMessage>())
    const captured: MemoryEntry[] = []
    const serviceLayer = buildServiceLayer(dbPath, queue, captured)

    await Effect.runPromise(
      Effect.gen(function* () {
        const consumer = yield* SubagentConsumer.Service
        yield* consumer.start({ sessionID: "ses_parent" as any, agent: "coder" })
        yield* Queue.offer(queue, {
          id: "msg-1",
          parentSessionID: "ses_parent" as any,
          fromSession: "ses_child" as any,
          fromAgent: "coder",
          kind: "plan",
          payload: { steps: ["read", "edit", "test"] },
          createdAt: Date.now(),
        })
        yield* Effect.sleep(50)
      }).pipe(Effect.provide(serviceLayer), Effect.scoped),
    )

    expect(captured).toHaveLength(1)
    expect(captured[0]?.key).toBe("plan:coder")
    expect(captured[0]?.value).toEqual({ steps: ["read", "edit", "test"] })
  })

  test("kill message exits the loop and the message is marked delivered", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const queue = await Effect.runPromise(Queue.unbounded<SubagentMessage>())
    const captured: MemoryEntry[] = []
    const serviceLayer = buildServiceLayer(dbPath, queue, captured)
    const dbLayer = Database.layerFromPath(dbPath)
    const messagesLayer = SubagentMessagesRepo.defaultLayer.pipe(Layer.provide(dbLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const consumer = yield* SubagentConsumer.Service
        const messages = yield* SubagentMessagesRepo.Service
        yield* messages.put({
          id: "kill-msg",
          parentSessionID: "ses_killtest" as any,
          fromSession: "ses_killtest" as any,
          fromAgent: "coder",
          kind: "kill",
          payload: {},
          createdAt: Date.now(),
        })
        yield* consumer.start({ sessionID: "ses_killtest" as any, agent: "coder" })
        yield* Queue.offer(queue, {
          id: "kill-msg",
          parentSessionID: "ses_killtest" as any,
          fromSession: "ses_killtest" as any,
          fromAgent: "coder",
          kind: "kill",
          payload: {},
          createdAt: Date.now(),
        })
        yield* Effect.sleep(80)
        const row = yield* messages.get("kill-msg")
        expect(row?.deliveredAt).toBeDefined()
      }).pipe(Effect.provide(serviceLayer), Effect.provide(messagesLayer), Effect.scoped),
    )
  })

  test("start returns void", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const queue = await Effect.runPromise(Queue.unbounded<SubagentMessage>())
    const captured: MemoryEntry[] = []
    const serviceLayer = buildServiceLayer(dbPath, queue, captured)

    await Effect.runPromise(
      Effect.gen(function* () {
        const consumer = yield* SubagentConsumer.Service
        const result = yield* consumer.start({ sessionID: "ses_voidtest" as any, agent: "coder" })
        expect(result).toBeUndefined()
      }).pipe(Effect.provide(serviceLayer), Effect.scoped),
    )
  })

  // Phase 1A G3: plan_update handling on the consumer. These tests verify
  // that a `kind: "plan_update"` message drives `SubagentPlansRepo.setStepStatus`
  // and that the consumer does not crash on unknown planIDs or out-of-bounds
  // step indices. Uses a real DB-backed SubagentPlans layer for test 1 so
  // `getByID` actually reads back the persisted update.
  test("plan_update advances a step in the persisted plan", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "plan-update-step.sqlite")
    const queue = await Effect.runPromise(Queue.unbounded<SubagentMessage>())
    const captured: MemoryEntry[] = []
    const dbLayer = Database.layerFromPath(dbPath)
    const plansLayer = SubagentPlans.defaultLayer.pipe(Layer.provide(dbLayer))
    // Provide the real SubagentPlans via Layer.merge so the consumer's
    // serviceOption lookup finds it at runtime. buildServiceLayerWithRealPlans
    // composes it via Layer.provide which can't satisfy a service the
    // consumer's layer doesn't declare as input — merge keeps both layers
    // independent and feeds their outputs into the same context.
    const serviceLayer = Layer.merge(buildServiceLayer(dbPath, queue, captured), plansLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const consumer = yield* SubagentConsumer.Service
        const plans = yield* SubagentPlans.Service
        const planID = "plan-update-step"

        yield* plans.put({
          id: planID,
          parentSessionID: "ses_parent" as any,
          agent: "coder",
          sessionID: "ses_child" as any,
          title: "Advance step",
          steps: [
            { content: "Step 0", status: "pending" },
            { content: "Step 1", status: "pending" },
          ],
          exitCriteria: "Done",
          status: "active",
          createdAt: Date.now(),
        })

        yield* consumer.start({ sessionID: "ses_child" as any, agent: "coder" })
        yield* Queue.offer(queue, {
          id: "msg-plan-update-1",
          parentSessionID: "ses_parent" as any,
          fromSession: "ses_parent" as any,
          fromAgent: "orchestrator",
          kind: "plan_update",
          planID,
          payload: { planID, stepIndex: 0, status: "in_progress" },
          createdAt: Date.now(),
        })
        yield* Effect.sleep(80)

        const updated = yield* plans.getByID(planID)
        expect(updated).toBeDefined()
        expect(updated?.steps[0]).toEqual({ content: "Step 0", status: "in_progress" })
        expect(updated?.steps[1]).toEqual({ content: "Step 1", status: "pending" })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped) as Effect.Effect<
        void,
        never,
        never
      >,
    )
  })

  test("plan_update with unknown planID is delivered without crashing", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "plan-update-unknown.sqlite")
    const queue = await Effect.runPromise(Queue.unbounded<SubagentMessage>())
    const captured: MemoryEntry[] = []
    const serviceLayer = buildServiceLayer(dbPath, queue, captured)
    const dbLayer = Database.layerFromPath(dbPath)
    const messagesLayer = SubagentMessagesRepo.defaultLayer.pipe(Layer.provide(dbLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const consumer = yield* SubagentConsumer.Service
        const messages = yield* SubagentMessagesRepo.Service

        yield* messages.put({
          id: "msg-plan-update-unknown",
          parentSessionID: "ses_unknown_parent" as any,
          fromSession: "ses_unknown_parent" as any,
          fromAgent: "orchestrator",
          kind: "plan_update",
          payload: { planID: "nonexistent", stepIndex: 0, status: "completed" },
          createdAt: Date.now(),
        })

        yield* consumer.start({ sessionID: "ses_unknown_parent" as any, agent: "coder" })
        yield* Queue.offer(queue, {
          id: "msg-plan-update-unknown",
          parentSessionID: "ses_unknown_parent" as any,
          fromSession: "ses_unknown_parent" as any,
          fromAgent: "orchestrator",
          kind: "plan_update",
          payload: { planID: "nonexistent", stepIndex: 0, status: "completed" },
          createdAt: Date.now(),
        })
        yield* Effect.sleep(80)

        const row = yield* messages.get("msg-plan-update-unknown")
        expect(row?.deliveredAt).toBeDefined()
        // Memory is unaffected — plan_update never writes to memory.
        expect(captured).toHaveLength(0)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(messagesLayer), Effect.scoped),
    )
  })

  test("plan_update with out-of-bounds stepIndex is delivered and the plan is unchanged", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "plan-update-oob.sqlite")
    const queue = await Effect.runPromise(Queue.unbounded<SubagentMessage>())
    const captured: MemoryEntry[] = []
    const dbLayer = Database.layerFromPath(dbPath)
    const plansLayer = SubagentPlans.defaultLayer.pipe(Layer.provide(dbLayer))
    const messagesLayer = SubagentMessagesRepo.defaultLayer.pipe(Layer.provide(dbLayer))
    // Provide the real SubagentPlans and SubagentMessagesRepo via
    // Layer.merge so the consumer's serviceOption lookup finds them at
    // runtime. buildServiceLayer internally satisfies both via its
    // `mockPlans` and `messagesLayer` provides, but Layer.merge only
    // exposes the top-level outputs of each layer — and buildServiceLayer's
    // top-level output is only `SubagentConsumer.Service`. We re-export
    // messagesLayer here so the test can yield* SubagentMessagesRepo.Service
    // to insert the message into the DB before the consumer reads it.
    const serviceLayer = Layer.mergeAll(
      buildServiceLayer(dbPath, queue, captured),
      plansLayer,
      messagesLayer,
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const consumer = yield* SubagentConsumer.Service
        const plans = yield* SubagentPlans.Service
        const messages = yield* SubagentMessagesRepo.Service
        const planID = "plan-update-oob"
        const createdAt = Date.now()

        yield* plans.put({
          id: planID,
          parentSessionID: "ses_oob_parent" as any,
          agent: "coder",
          sessionID: "ses_oob_child" as any,
          title: "OOB test",
          steps: [{ content: "Only step", status: "pending" }],
          exitCriteria: "Done",
          status: "active",
          createdAt,
        })
        const before = yield* plans.getByID(planID)
        expect(before?.steps.length).toBe(1)

        yield* messages.put({
          id: "msg-plan-update-oob",
          parentSessionID: "ses_oob_parent" as any,
          fromSession: "ses_oob_parent" as any,
          fromAgent: "orchestrator",
          kind: "plan_update",
          payload: { planID, stepIndex: 5, status: "completed" },
          createdAt: Date.now(),
        })

        yield* consumer.start({ sessionID: "ses_oob_child" as any, agent: "coder" })
        yield* Queue.offer(queue, {
          id: "msg-plan-update-oob",
          parentSessionID: "ses_oob_parent" as any,
          fromSession: "ses_oob_parent" as any,
          fromAgent: "orchestrator",
          kind: "plan_update",
          payload: { planID, stepIndex: 5, status: "completed" },
          createdAt: Date.now(),
        })
        yield* Effect.sleep(80)

        const after = yield* plans.getByID(planID)
        expect(after).toBeDefined()
        expect(after?.steps).toEqual([{ content: "Only step", status: "pending" }])
        expect(after?.updatedAt).toBe(before?.updatedAt)

        const row = yield* messages.get("msg-plan-update-oob")
        expect(row?.deliveredAt).toBeDefined()
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped) as Effect.Effect<
        void,
        never,
        never
      >,
    )
  })
})

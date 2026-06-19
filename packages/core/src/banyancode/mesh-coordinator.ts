export * as MeshCoordinator from "./mesh-coordinator"

import { Context, Effect, Layer, Queue, Ref, Schema, Stream } from "effect"
import { EventV2 } from "../event"
import { SessionSchema } from "../session/schema"
import { SubagentBus } from "./subagent-bus"
import { SubagentPlans } from "./subagent-plans-repo"
import type { PeerInfo, SubagentMessage } from "./types"

export const MeshStatus = Schema.Struct({
  parentSessionID: Schema.String,
  peers: Schema.Array(
    Schema.Struct({
      sessionID: Schema.String,
      agent: Schema.String,
      status: Schema.Union([Schema.Literal("active"), Schema.Literal("idle"), Schema.Literal("disconnected")]),
      lastSeenAt: Schema.Number,
    }),
  ),
  pendingMessages: Schema.Number,
  recentActivity: Schema.Array(
    Schema.Struct({
      from: Schema.String,
      at: Schema.Number,
    }),
  ),
})

export type MeshStatus = typeof MeshStatus.Type

export interface Interface {
  readonly status: (parentSessionID: SessionSchema.ID) => Effect.Effect<MeshStatus, never, never>
  readonly drain: (parentSessionID: SessionSchema.ID) => Effect.Effect<SubagentMessage[], never, never>
  readonly watch: (parentSessionID: SessionSchema.ID) => Effect.Effect<Stream.Stream<MeshStatus>, never, never>
  readonly subscribe: (input: { parentSessionID: SessionSchema.ID; agentName?: string }) => Effect.Effect<Stream.Stream<SubagentMessage, never, never>, never, never>
  readonly checkin: (
    parentSessionID: SessionSchema.ID,
  ) => Effect.Effect<Array<{ agent: string; sessionID: string; lastSeenAt: number; lastCheckpoint?: { summary: string; todos: unknown } }>, never, never>
  readonly steer: (input: {
    parentSessionID: SessionSchema.ID
    targetAgent: string
    instruction: string
    priority?: "low" | "normal" | "high"
  }) => Effect.Effect<void, never, never>
  readonly kill: (input: { parentSessionID: SessionSchema.ID; targetAgent: string; reason: string }) => Effect.Effect<void, never, never>
  readonly planFor: (input: {
    parentSessionID: SessionSchema.ID
    targetAgent: string
    plan: { title: string; steps: Array<{ content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }>; exitCriteria: string }
  }) => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/MeshCoordinator") {}

export const StatusUpdated = EventV2.define({
  type: "banyancode.mesh.status",
  schema: MeshStatus.fields,
})

const ACTIVITY_WINDOW_MS = 5 * 60 * 1000

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* SubagentBus.Service
    const plans = yield* SubagentPlans.Service
    const events = yield* EventV2.Service
    const activityRef = yield* Ref.make(new Map<string, Array<{ from: string; at: number }>>())

    const status = Effect.fn("MeshCoordinator.status")(function* (parentSessionID: SessionSchema.ID) {
      const peers = yield* bus.peers(parentSessionID)
      const recent = (yield* Ref.get(activityRef)).get(parentSessionID) ?? []
      const cutoff = Date.now() - ACTIVITY_WINDOW_MS
      return {
        parentSessionID,
        peers,
        pendingMessages: 0,
        recentActivity: recent.filter((a) => a.at >= cutoff),
      }
    })

    const drain = Effect.fn("MeshCoordinator.drain")(function* (parentSessionID: SessionSchema.ID) {
      const queue = yield* bus.subscribe(parentSessionID)
      const drained: SubagentMessage[] = []
      let item = yield* Queue.poll(queue)
      while (item._tag === "Some") {
        drained.push(item.value)
        item = yield* Queue.poll(queue)
      }
      return drained
    })

    const watch = Effect.fn("MeshCoordinator.watch")(function* (parentSessionID: SessionSchema.ID) {
      const meshStatus = yield* status(parentSessionID)
      yield* events.publish(StatusUpdated, meshStatus)
      return Stream.make(meshStatus)
    })

    const subscribe: Interface["subscribe"] = (input) =>
      Effect.gen(function* () {
        const queue = yield* bus.subscribe(input.parentSessionID)
        const stream = Stream.fromQueue(queue)
        if (input.agentName) {
          return stream.pipe(
            Stream.filter((m) => m.fromAgent === input.agentName || m.toAgent === input.agentName),
          )
        }
        return stream
      })

    const checkin = Effect.fn("MeshCoordinator.checkin")(function* (
      parentSessionID: SessionSchema.ID,
    ) {
      const peers = yield* bus.peers(parentSessionID)
      const queue = yield* bus.subscribe(parentSessionID)
      const allMessages: SubagentMessage[] = []
      let item = yield* Queue.poll(queue)
      while (item._tag === "Some") {
        allMessages.push(item.value)
        item = yield* Queue.poll(queue)
      }

      const checkpointBySession = new Map<string, SubagentMessage>()
      for (const msg of allMessages) {
        if (msg.kind === "checkpoint" && msg.fromSession) {
          const existing = checkpointBySession.get(msg.fromSession)
          if (!existing || msg.createdAt > existing.createdAt) {
            checkpointBySession.set(msg.fromSession, msg)
          }
        }
      }

      return peers.map((peer) => ({
        agent: peer.agent,
        sessionID: peer.sessionID,
        lastSeenAt: peer.lastSeenAt,
        lastCheckpoint: checkpointBySession.get(peer.sessionID)?.payload as { summary: string; todos: unknown } | undefined,
      }))
    })

    const steer = Effect.fn("MeshCoordinator.steer")(function* (input: {
      parentSessionID: SessionSchema.ID
      targetAgent: string
      instruction: string
      priority?: "low" | "normal" | "high"
    }) {
      const message: SubagentMessage = {
        id: crypto.randomUUID(),
        parentSessionID: input.parentSessionID,
        fromSession: input.parentSessionID,
        fromAgent: "orchestrator",
        toAgent: input.targetAgent,
        kind: "steer",
        payload: { instruction: input.instruction, priority: input.priority },
        createdAt: Date.now(),
      }
      yield* bus.publish(message)
    })

    const kill = Effect.fn("MeshCoordinator.kill")(function* (input: {
      parentSessionID: SessionSchema.ID
      targetAgent: string
      reason: string
    }) {
      const message: SubagentMessage = {
        id: crypto.randomUUID(),
        parentSessionID: input.parentSessionID,
        fromSession: input.parentSessionID,
        fromAgent: "orchestrator",
        toAgent: input.targetAgent,
        kind: "kill",
        payload: { reason: input.reason },
        createdAt: Date.now(),
      }
      yield* bus.publish(message)
    })

    const planFor = Effect.fn("MeshCoordinator.planFor")(function* (input: {
      parentSessionID: SessionSchema.ID
      targetAgent: string
      plan: { title: string; steps: Array<{ content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }>; exitCriteria: string }
    }) {
      const planID = crypto.randomUUID()
      const now = Date.now()

      yield* plans.put({
        id: planID,
        parentSessionID: input.parentSessionID,
        agent: input.targetAgent,
        sessionID: input.parentSessionID,
        title: input.plan.title,
        steps: input.plan.steps,
        exitCriteria: input.plan.exitCriteria,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })

      const message: SubagentMessage = {
        id: crypto.randomUUID(),
        parentSessionID: input.parentSessionID,
        fromSession: input.parentSessionID,
        fromAgent: "orchestrator",
        toAgent: input.targetAgent,
        kind: "plan",
        payload: input.plan,
        createdAt: Date.now(),
      }
      yield* bus.publish(message)
    })

    return Service.of({ status, drain, watch, subscribe, checkin, steer, kill, planFor })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SubagentBus.defaultLayer),
  Layer.provide(SubagentPlans.defaultLayer),
)
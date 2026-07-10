export * as MeshCoordinator from "./mesh-coordinator"

import { Context, Effect, Layer, Queue, Ref, Schema, Stream } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { SubagentBus } from "./subagent-bus"
import { SubagentPlans } from "./subagent-plans-repo"
import { MaxSubagents } from "./max-subagents"
import { DEFAULT_MAX_SUBAGENTS } from "../v1/config/banyan-config"
import type { PeerInfo, SubagentMessage } from "./types"

export const MeshStatus = Schema.Struct({
  parentSessionID: Schema.String,
  peers: Schema.Array(
    Schema.Struct({
      sessionID: Schema.String,
      agent: Schema.String,
      status: Schema.Union([Schema.Literal("active"), Schema.Literal("idle"), Schema.Literal("disconnected")]),
      lastSeenAt: Schema.Number,
      cost: Schema.optional(Schema.Number),
      tokens: Schema.optional(
        Schema.Struct({
          input: Schema.Number,
          output: Schema.Number,
          reasoning: Schema.Number,
          cache: Schema.Struct({
            read: Schema.Number,
            write: Schema.Number,
          }),
        }),
      ),
      lastActivityAt: Schema.optional(Schema.Number),
      blockedReason: Schema.optional(Schema.String),
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
  readonly trackParent: (parentSessionID: SessionSchema.ID) => Effect.Effect<void, never, never>
  readonly listTrackedParents: () => Effect.Effect<ReadonlyArray<SessionSchema.ID>, never, never>
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
  readonly tryReserveSubagentSlot: (
    parentSessionID: SessionSchema.ID,
  ) => Effect.Effect<{ ok: true; killed: string | null } | { ok: false; error: string }, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/MeshCoordinator") {}

export const StatusUpdated = EventV2.define({
  type: "banyancode.mesh.status",
  schema: MeshStatus.fields,
})

const ACTIVITY_WINDOW_MS = 5 * 60 * 1000
const COST_CACHE_TTL_MS = 5 * 1000
const NATIVE_CHILD_RECENT_MS = 5 * 60 * 1000

type NativeChildRow = {
  id: string
  parent_id: string | null
  title: string
  agent: string | null
  time_created: number
  time_updated: number
}

const listNativeChildren = (
  parentSessionID: SessionSchema.ID,
  db: Database.Interface["db"],
): Effect.Effect<NativeChildRow[], never, never> =>
  db
    .all<NativeChildRow>(
      sql`SELECT id, parent_id, title, agent, time_created, time_updated
          FROM session
          WHERE parent_id = ${parentSessionID}
          ORDER BY time_updated DESC`,
    )
    .pipe(Effect.orDie)

type CostCacheEntry = {
  cost: number
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  lastActivityAt: number
  blockedReason?: string
  computedAt: number
}

const computePeerCost = (sessionID: string, agent: string, db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    const row = yield* db
      .get<{
        cost: number
        tokens_input: number
        tokens_output: number
        tokens_reasoning: number
        tokens_cache_read: number
        tokens_cache_write: number
        last_activity: number | null
      }>(
        sql`SELECT
            COALESCE(SUM(JSON_EXTRACT(data, '$.cost')), 0) as cost,
            COALESCE(SUM(JSON_EXTRACT(data, '$.tokens.input')), 0) as tokens_input,
            COALESCE(SUM(JSON_EXTRACT(data, '$.tokens.output')), 0) as tokens_output,
            COALESCE(SUM(JSON_EXTRACT(data, '$.tokens.reasoning')), 0) as tokens_reasoning,
            COALESCE(SUM(JSON_EXTRACT(data, '$.tokens.cache.read')), 0) as tokens_cache_read,
            COALESCE(SUM(JSON_EXTRACT(data, '$.tokens.cache.write')), 0) as tokens_cache_write,
            MAX(JSON_EXTRACT(data, '$.time.completed')) as last_activity
          FROM session_message
          WHERE session_id = ${sessionID}
            AND type = 'assistant'
            AND JSON_EXTRACT(data, '$.agent') = ${agent}`,
      )
      .pipe(Effect.orDie)

    if (!row || row.cost === 0) return null

    return {
      cost: row.cost,
      tokens: {
        input: row.tokens_input,
        output: row.tokens_output,
        reasoning: row.tokens_reasoning,
        cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
      },
      lastActivityAt: row.last_activity ?? 0,
    }
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* SubagentBus.Service
    const plans = yield* SubagentPlans.Service
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    const activityRef = yield* Ref.make(new Map<string, Array<{ from: string; at: number }>>())
    const costCacheRef = yield* Ref.make(new Map<string, CostCacheEntry>())
    const trackedParentsRef = yield* Ref.make(new Set<SessionSchema.ID>())

    const status = Effect.fn("MeshCoordinator.status")(function* (parentSessionID: SessionSchema.ID) {
      const peers = yield* bus.peers(parentSessionID)
      const recent = (yield* Ref.get(activityRef)).get(parentSessionID) ?? []
      const cutoff = Date.now() - ACTIVITY_WINDOW_MS
      const now = Date.now()
      const cache = yield* Ref.get(costCacheRef)

      const enrichedPeers = yield* Effect.forEach(peers, (peer) =>
        Effect.gen(function* () {
          const cacheKey = `${peer.sessionID}:${peer.agent}`
          const cached = cache.get(cacheKey)
          if (cached && now - cached.computedAt <= COST_CACHE_TTL_MS) {
            return {
              ...peer,
              cost: cached.cost,
              tokens: cached.tokens,
              lastActivityAt: cached.lastActivityAt,
              blockedReason: peer.status === "disconnected" ? cached.blockedReason : undefined,
            }
          }

          const computed = yield* computePeerCost(peer.sessionID, peer.agent, db)

          if (computed) {
            const entry: CostCacheEntry = { ...computed, computedAt: now }
            yield* Ref.update(costCacheRef, (c) => {
              const next = new Map(c)
              next.set(cacheKey, entry)
              return next
            })
            return {
              ...peer,
              cost: computed.cost,
              tokens: computed.tokens,
              lastActivityAt: computed.lastActivityAt,
            }
          }

          return peer
        }),
      )

      const nativeChildren = yield* listNativeChildren(parentSessionID, db)
      const nativeChildCutoff = now - NATIVE_CHILD_RECENT_MS
      const nativePeers: MeshStatus["peers"] = nativeChildren.map((row) => {
        const lastSeen = Math.max(row.time_updated, row.time_created)
        const status: "active" | "idle" | "disconnected" =
          lastSeen >= nativeChildCutoff ? "active" : "idle"
        return {
          sessionID: row.id,
          agent: row.agent ?? "subagent",
          status,
          lastSeenAt: lastSeen,
        }
      })

      const busSessionIDs = new Set(enrichedPeers.map((p) => p.sessionID))
      const mergedPeers: MeshStatus["peers"] = [
        ...enrichedPeers,
        ...nativePeers.filter((p) => !busSessionIDs.has(p.sessionID)),
      ]

      return {
        parentSessionID,
        peers: mergedPeers,
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

    const tryReserveSubagentSlot = Effect.fn("MeshCoordinator.tryReserveSubagentSlot")(function* (
      parentSessionID: SessionSchema.ID,
    ) {
      const maxSvc = yield* Effect.serviceOption(MaxSubagents.Service)
      const max = maxSvc._tag === "Some" ? yield* maxSvc.value.current() : DEFAULT_MAX_SUBAGENTS

      const checkins = yield* checkin(parentSessionID)
      if (checkins.length < max) return { ok: true, killed: null } as const

      // At limit: find oldest ended subagent (idle/disconnected > 60s ago)
      const endedOldest = checkins
        .filter((c) => {
          // Consider "ended" if not seen in over 60 seconds
          return c.lastSeenAt && Date.now() - c.lastSeenAt > 60_000
        })
        .sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0]

      if (endedOldest) {
        yield* kill({ parentSessionID, targetAgent: endedOldest.agent, reason: "evicted-by-new-spawn" })
        return { ok: true, killed: endedOldest.agent } as const
      }

      return {
        ok: false,
        error: `Max ${max} subagents reached. No idle agents to evict.`,
      } as const
    })

    const trackParent: Interface["trackParent"] = Effect.fn("MeshCoordinator.trackParent")(function* (
      parentSessionID: SessionSchema.ID,
    ) {
      yield* Ref.update(trackedParentsRef, (set) => {
        const next = new Set(set)
        next.add(parentSessionID)
        return next
      })
    })

    const listTrackedParents: Interface["listTrackedParents"] = Effect.fn(
      "MeshCoordinator.listTrackedParents",
    )(function* () {
      return Array.from(yield* Ref.get(trackedParentsRef))
    })

    return Service.of({
      status,
      drain,
      watch,
      subscribe,
      checkin,
      steer,
      kill,
      planFor,
      tryReserveSubagentSlot,
      trackParent,
      listTrackedParents,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SubagentBus.defaultLayer),
  Layer.provide(SubagentPlans.defaultLayer),
  Layer.provide(Database.defaultLayer),
)
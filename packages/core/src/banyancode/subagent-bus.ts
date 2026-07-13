export * as SubagentBus from "./subagent-bus"

import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Queue } from "effect"
import { Database } from "../database/database"
import { SubagentMessagesTable } from "./subagent-messages.sql"
import { SubagentMessagesRepo } from "./subagent-messages-repo"
import { wrapPayload } from "./subagent-types"
import type { PeerInfo, SubagentMessage } from "./types"

export interface PublishResult {
  id: string
  createdAt: number
  /** True if this call created the row; false if an existing row was returned. */
  created: boolean
}

export interface Interface {
  readonly publish: (msg: SubagentMessage) => Effect.Effect<void>
  /** Insert-or-conflict for idempotent retry. Returns the row's id, createdAt, and
   * whether this call created the row (true) or fetched an existing one (false). */
  readonly publishOrFetch: (msg: SubagentMessage) => Effect.Effect<PublishResult>
  readonly subscribe: (sessionID: string) => Effect.Effect<Queue.Dequeue<SubagentMessage>>
  readonly peers: (parentSessionID: string) => Effect.Effect<PeerInfo[]>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/SubagentBus") {}

const PEER_WINDOW_MS = 5 * 60 * 1000

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* SubagentMessagesRepo.Service
    const { db } = yield* Database.Service

    const publish = Effect.fn("SubagentBus.publish")(function* (msg: SubagentMessage) {
      yield* repo.put(msg)
    })

    /**
     * SQLite-correct idempotent insert-or-fetch.
     *
     * Uses `ON CONFLICT(id) DO UPDATE SET id = id RETURNING id, created_at`.
     * The no-op self-update guarantees a row is always returned.
     * Whether this call created the row is decided by comparing the returned
     * `created_at` to the `createdAt` value we passed in — if they differ, a
     * prior row won the race.
     */
    const publishOrFetch = Effect.fn("SubagentBus.publishOrFetch")(function* (
      msg: SubagentMessage,
    ) {
      const wrappedPayload = wrapPayload(msg.payload)
      const rows = yield* (db
        .insert(SubagentMessagesTable)
        .values({
          id: msg.id,
          parent_session_id: msg.parentSessionID,
          from_session: msg.fromSession,
          from_agent: msg.fromAgent,
          to_session: msg.toSession,
          to_agent: msg.toAgent,
          kind: msg.kind,
          payload: wrappedPayload,
          created_at: msg.createdAt,
          delivered_at: msg.deliveredAt,
        })
        .onConflictDoUpdate({
          target: SubagentMessagesTable.id,
          set: { id: sql`id` },
        })
        .returning({ id: SubagentMessagesTable.id, created_at: SubagentMessagesTable.created_at })
        .run() as any) as Effect.Effect<Array<{ id: string; created_at: number }>, never, never>

      const row = rows[0]
      if (!row) throw new Error("publishOrFetch: no row returned")
      return {
        id: row.id,
        createdAt: row.created_at,
        created: row.created_at === msg.createdAt,
      }
    })

    const subscribe = (sessionID: string) =>
      Effect.gen(function* () {
        const pending = yield* repo.listByParent(sessionID, false)
        const queue = yield* Queue.bounded<SubagentMessage>(100)
        ;(yield* Effect.addFinalizer(() => Queue.shutdown(queue))) as unknown as void
        for (const msg of pending) {
          yield* Queue.offer(queue, msg)
        }
        return queue
      }) as unknown as Effect.Effect<Queue.Dequeue<SubagentMessage>, never, never>

    const peers = Effect.fn("SubagentBus.peers")(function* (parentSessionID: string) {
      const cutoff = Date.now() - PEER_WINDOW_MS
      const messages = yield* repo.listByParent(parentSessionID, true)
      const recent = messages.filter((m) => m.createdAt >= cutoff)
      const seen = new Map<string, PeerInfo>()
      for (const msg of recent) {
        if (!msg.fromSession) continue
        const existing = seen.get(msg.fromSession)
        if (!existing || msg.createdAt > existing.lastSeenAt) {
          seen.set(msg.fromSession, {
            sessionID: msg.fromSession,
            agent: msg.fromAgent,
            status: "active",
            lastSeenAt: msg.createdAt,
          })
        }
      }
      return Array.from(seen.values())
    })

    return Service.of({ publish, publishOrFetch, subscribe, peers })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SubagentMessagesRepo.defaultLayer))

import { Effect } from "effect"
import type { Interface as Storage, StorageError } from "../storage/service.js"
import { decodePayload, encodePayload } from "./payload.js"
import type { MessageKind, PeerInfo, SubagentMessage } from "./types.js"

interface MessageRow {
  readonly id: string
  readonly parent_session_id: string
  readonly from_session: string
  readonly from_agent: string
  readonly to_session: string | null
  readonly to_agent: string | null
  readonly kind: string
  readonly payload: string
  readonly created_at: number
  readonly delivered_at: number | null
}

const toMessage = (row: MessageRow): SubagentMessage => ({
  id: row.id,
  parentSessionID: row.parent_session_id,
  fromSession: row.from_session,
  fromAgent: row.from_agent,
  ...(row.to_session === null ? {} : { toSession: row.to_session }),
  ...(row.to_agent === null ? {} : { toAgent: row.to_agent }),
  kind: row.kind as MessageKind,
  payload: decodePayload(row.payload),
  ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
  createdAt: Number(row.created_at),
})

const nullable = (value: string | undefined): string | null => value ?? null

export interface PublishResult {
  readonly id: string
  readonly createdAt: number
  /** True when this call created the row; false when an existing row won. */
  readonly created: boolean
}

export interface MessagesRepo {
  /** Full upsert (coordinator/system messages). */
  readonly put: (message: SubagentMessage) => Effect.Effect<void, StorageError>
  /**
   * Idempotent insert-or-fetch. The conflict branch only touches `id`, so a
   * redelivered `subagent_message` retry never clears `delivered_at` and never
   * duplicates the row (v1 Phase 1 idempotency lesson).
   */
  readonly publishOrFetch: (message: SubagentMessage) => Effect.Effect<PublishResult, StorageError>
  readonly get: (id: string) => Effect.Effect<SubagentMessage | undefined, StorageError>
  readonly listByParent: (parentSessionID: string, delivered?: boolean) => Effect.Effect<readonly SubagentMessage[], StorageError>
  readonly listPending: (parentSessionID: string) => Effect.Effect<readonly SubagentMessage[], StorageError>
  readonly countPending: (parentSessionID: string) => Effect.Effect<number, StorageError>
  readonly markDelivered: (id: string, deliveredAt: number) => Effect.Effect<void, StorageError>
  readonly peers: (parentSessionID: string, windowMs?: number) => Effect.Effect<readonly PeerInfo[], StorageError>
}

const PEER_WINDOW_MS = 5 * 60 * 1000

export const makeMessagesRepo = (storage: Storage): MessagesRepo => {
  const put: MessagesRepo["put"] = (message) =>
    storage
      .query(
        `INSERT INTO subagent_messages
           (id, parent_session_id, from_session, from_agent, to_session, to_agent, kind, payload, created_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           parent_session_id = excluded.parent_session_id,
           from_session = excluded.from_session,
           from_agent = excluded.from_agent,
           to_session = excluded.to_session,
           to_agent = excluded.to_agent,
           kind = excluded.kind,
           payload = excluded.payload,
           created_at = excluded.created_at,
           delivered_at = excluded.delivered_at`,
        [
          message.id,
          message.parentSessionID,
          message.fromSession,
          message.fromAgent,
          nullable(message.toSession),
          nullable(message.toAgent),
          message.kind,
          encodePayload(message.payload),
          message.createdAt,
          message.deliveredAt ?? null,
        ],
      )
      .pipe(Effect.asVoid)

  const publishOrFetch: MessagesRepo["publishOrFetch"] = (message) =>
    storage
      .query<{ id: string; created_at: number }>(
        `INSERT INTO subagent_messages
           (id, parent_session_id, from_session, from_agent, to_session, to_agent, kind, payload, created_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET id = id
         RETURNING id, created_at`,
        [
          message.id,
          message.parentSessionID,
          message.fromSession,
          message.fromAgent,
          nullable(message.toSession),
          nullable(message.toAgent),
          message.kind,
          encodePayload(message.payload),
          message.createdAt,
          message.deliveredAt ?? null,
        ],
      )
      .pipe(
        Effect.map((rows) => {
          const row = rows[0]
          if (row === undefined) throw new Error(`publishOrFetch: no row returned for ${message.id}`)
          return { id: row.id, createdAt: Number(row.created_at), created: Number(row.created_at) === message.createdAt }
        }),
      )

  const get: MessagesRepo["get"] = (id) =>
    storage
      .query<MessageRow>("SELECT * FROM subagent_messages WHERE id = ?", [id])
      .pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : toMessage(rows[0]))))

  const listByParent: MessagesRepo["listByParent"] = (parentSessionID, delivered) =>
    storage
      .query<MessageRow>(
        delivered === undefined
          ? "SELECT * FROM subagent_messages WHERE parent_session_id = ? ORDER BY created_at ASC"
          : delivered
            ? "SELECT * FROM subagent_messages WHERE parent_session_id = ? AND delivered_at IS NOT NULL ORDER BY created_at ASC"
            : "SELECT * FROM subagent_messages WHERE parent_session_id = ? AND delivered_at IS NULL ORDER BY created_at ASC",
        [parentSessionID],
      )
      .pipe(Effect.map((rows) => rows.map(toMessage)))

  const listPending: MessagesRepo["listPending"] = (parentSessionID) => listByParent(parentSessionID, false)

  const countPending: MessagesRepo["countPending"] = (parentSessionID) =>
    storage
      .query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM subagent_messages WHERE parent_session_id = ? AND delivered_at IS NULL",
        [parentSessionID],
      )
      .pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)))

  const markDelivered: MessagesRepo["markDelivered"] = (id, deliveredAt) =>
    storage
      .query("UPDATE subagent_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL", [
        deliveredAt,
        id,
      ])
      .pipe(Effect.asVoid)

  const peers: MessagesRepo["peers"] = (parentSessionID, windowMs = PEER_WINDOW_MS) =>
    storage
      .query<MessageRow>(
        "SELECT * FROM subagent_messages WHERE parent_session_id = ? AND created_at >= ? ORDER BY created_at ASC",
        [parentSessionID, Date.now() - windowMs],
      )
      .pipe(
        Effect.map((rows) => {
          const seen = new Map<string, PeerInfo>()
          for (const row of rows) {
            if (row.from_session.length === 0) continue
            const existing = seen.get(row.from_session)
            if (existing === undefined || row.created_at > existing.lastSeenAt) {
              seen.set(row.from_session, {
                sessionID: row.from_session,
                agent: row.from_agent,
                status: "active",
                lastSeenAt: Number(row.created_at),
              })
            }
          }
          return Array.from(seen.values())
        }),
      )

  return { put, publishOrFetch, get, listByParent, listPending, countPending, markDelivered, peers }
}

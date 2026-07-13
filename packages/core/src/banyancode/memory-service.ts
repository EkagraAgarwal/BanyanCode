/**
 * BanyanCode MemoryService.
 *
 * Phase 1b thin layer over MemoryRepo that owns the candidate lifecycle:
 * - emitCandidate → put a row with status="pending"
 * - promote → transactional status="active" + supersede conflicting actives
 * - reject → status="rejected"
 * - listCandidates → filtered list for the TUI / CLI
 *
 * MemoryService is the only place that publishes EventV2 memory events.
 * MemoryRepo stays a pure CRUD layer (no bus coupling) per AGENTS.md.
 */

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Queue } from "effect"
import { randomUUID } from "node:crypto"
import { Database } from "../database/database"
import { MemoryEntriesTable } from "./memory.sql"
import { MemoryRepo, mapMemoryRowToEntry } from "./memory-repo"
import { payloadFingerprint, unwrapMemoryValue, type MemoryPayloadV1 } from "./memory-payload"
import { MemoryCandidateEmitted, MemoryCommitted, MemoryPromoted, MemoryRejected } from "./memory-events"
import type { MemoryEntry } from "./types"
import { NotFoundError, StaleWriteError } from "./types"

export interface EmitCandidateInput {
  /** Caller-provided id; generated if omitted. */
  id?: string
  key: string
  /** Structured payload OR legacy raw value (wrapped as observation). */
  value: unknown
  context?: string
  tags?: string[]
  scope?: "global" | "session"
  sessionID?: string
  agentID?: string
}

export interface PromoteInput {
  id: string
  expectedVersion: number
  /** Optional override for the new active row's key (rename on promote). */
  key?: string
  scope?: "global" | "session"
  /** If true, also force-set status="active" without superseding matches. */
  skipSupersede?: boolean
}

export interface RejectInput {
  id: string
  expectedVersion: number
}

export interface ListCandidatesInput {
  status?: "pending" | "active" | "superseded" | "rejected" | "expired"
  scope?: "global" | "session"
  limit?: number
}

export interface MemoryEventEnvelope {
  type:
    | "banyancode.memory.committed"
    | "banyancode.memory.candidate_emitted"
    | "banyancode.memory.promoted"
    | "banyancode.memory.rejected"
  properties: Record<string, unknown>
}

export interface Interface {
  readonly emitCandidate: (input: EmitCandidateInput) => Effect.Effect<MemoryEntry, never, never>
  readonly promote: (
    input: PromoteInput,
  ) => Effect.Effect<{ entry: MemoryEntry; supersededIds: string[] }, NotFoundError | StaleWriteError, never>
  readonly reject: (input: RejectInput) => Effect.Effect<MemoryEntry, NotFoundError | StaleWriteError, never>
  readonly listCandidates: (input?: ListCandidatesInput) => Effect.Effect<MemoryEntry[], never, never>
  /** Bounded events queue; bridge drains it. Do not consume internally. */
  readonly events: () => Queue.Dequeue<MemoryEventEnvelope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Banyan/MemoryService") {}

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

const toCandidateId = (input: { id?: string; key: string }) =>
  input.id ?? `candidate:${randomUUID()}`

export const layer: Layer.Layer<Service, never, MemoryRepo.Service | Database.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (!banyancodeEnabled()) {
      const events = yield* Queue.bounded<MemoryEventEnvelope>(64).pipe(Effect.orDie)
      yield* Effect.addFinalizer(() => Queue.shutdown(events))
      const eventsDequeue: Interface["events"] = () => events
      return Service.of({
        emitCandidate: () => Effect.die("banyancode disabled"),
        promote: () => Effect.die("banyancode disabled"),
        reject: () => Effect.die("banyancode disabled"),
        listCandidates: () => Effect.succeed([]),
        events: eventsDequeue,
      })
    }

    const repo = yield* MemoryRepo.Service
    const { db } = yield* Database.Service
    const events = yield* Queue.bounded<MemoryEventEnvelope>(64).pipe(Effect.orDie)
    yield* Effect.addFinalizer(() => Queue.shutdown(events))
    const eventsDequeue: Interface["events"] = () => events

    const publish = (envelope: MemoryEventEnvelope) =>
      Queue.offer(events, envelope).pipe(Effect.ignore)

    const emitCandidate: Interface["emitCandidate"] = (input) =>
      Effect.gen(function* () {
        const id = toCandidateId(input)
        const scope = input.scope ?? "session"
        const sessionID = scope === "session" ? input.sessionID : undefined
        yield* repo.put({
          id,
          key: input.key,
          value: input.value,
          context: input.context,
          tags: input.tags ?? [],
          scope,
          sessionID,
          agentID: input.agentID,
          overrides: { status: "pending" },
        })
        const entry = yield* repo.get(id)
        // entry is non-null because we just wrote it.
        const safe = entry!
        const fingerprint = unwrapMemoryValue(safe.value, safe.key)
        yield* publish({
          type: "banyancode.memory.candidate_emitted",
          properties: {
            id: safe.id,
            key: safe.key,
            scope: safe.scope,
            kind: fingerprint.kind,
            title: fingerprint.title,
            sessionID: safe.sessionID,
          },
        })
        return safe
      })

    const promote: Interface["promote"] = (input) =>
      Effect.gen(function* () {
        const now = Date.now()
        const supersededIds: string[] = []
        const result = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const current = yield* tx
                .select()
                .from(MemoryEntriesTable)
                .where(eq(MemoryEntriesTable.id, input.id))
                .get()
                .pipe(Effect.orDie)
              if (!current) {
                return yield* Effect.fail(new NotFoundError({ id: input.id }))
              }
              if (current.version !== input.expectedVersion) {
                return yield* Effect.fail(
                  new StaleWriteError({
                    id: input.id,
                    expectedVersion: input.expectedVersion,
                    currentVersion: current.version,
                  }),
                )
              }

              const nextScope = input.scope ?? current.scope
              const nextKey = input.key ?? current.key

              // Supersede existing active entries with the same fingerprint.
              if (!input.skipSupersede) {
                const fingerprint = unwrapMemoryValue(current.value, current.key)
                const conflict = yield* tx
                  .select({ id: MemoryEntriesTable.id, key: MemoryEntriesTable.key, value: MemoryEntriesTable.value })
                  .from(MemoryEntriesTable)
                  .where(
                    and(
                      eq(MemoryEntriesTable.status, "active"),
                      eq(MemoryEntriesTable.scope, nextScope),
                      sql`${MemoryEntriesTable.id} != ${current.id}`,
                    ),
                  )
                  .all()
                  .pipe(Effect.orDie)

                for (const row of conflict) {
                  if (payloadFingerprint(unwrapMemoryValue(row.value, row.key)) === payloadFingerprint(fingerprint)) {
                    yield* tx
                      .update(MemoryEntriesTable)
                      .set({ status: "superseded", updated_at: now })
                      .where(eq(MemoryEntriesTable.id, row.id))
                      .run()
                      .pipe(Effect.orDie)
                    supersededIds.push(row.id)
                  }
                }
              }

              yield* tx
                .update(MemoryEntriesTable)
                .set({
                  key: nextKey,
                  scope: nextScope,
                  status: "active",
                  version: current.version + 1,
                  updated_at: now,
                })
                .where(and(eq(MemoryEntriesTable.id, current.id), eq(MemoryEntriesTable.version, current.version)))
                .run()
                .pipe(Effect.orDie)

              const updated = yield* tx
                .select()
                .from(MemoryEntriesTable)
                .where(eq(MemoryEntriesTable.id, current.id))
                .get()
                .pipe(Effect.orDie)

              return mapRowToEntry(updated!)
            }),
          )
          .pipe(Effect.orDie)

        const fingerprint = unwrapMemoryValue(result.value, result.key)
        yield* publish({
          type: "banyancode.memory.promoted",
          properties: {
            id: result.id,
            key: result.key,
            scope: result.scope,
            supersededIds,
          },
        })
        yield* publish({
          type: "banyancode.memory.committed",
          properties: {
            id: result.id,
            key: result.key,
            scope: result.scope,
            kind: fingerprint.kind,
            title: fingerprint.title,
            status: result.status ?? "active",
            version: result.version,
          },
        })

        return { entry: result, supersededIds }
      })

    const reject: Interface["reject"] = (input) =>
      Effect.gen(function* () {
        const updated = yield* repo.update({
          id: input.id,
          expectedVersion: input.expectedVersion,
          overrides: { status: "rejected" },
        })
        yield* publish({
          type: "banyancode.memory.rejected",
          properties: { id: updated.id, key: updated.key },
        })
        return updated
      })

    const listCandidates: Interface["listCandidates"] = (input = {}) =>
      Effect.gen(function* () {
        const limit = Math.max(1, Math.min(input.limit ?? 100, 500))
        const status = input.status ?? "pending"
        const scopeFilter = input.scope ? eq(MemoryEntriesTable.scope, input.scope) : undefined
        const rows = yield* db
          .select()
          .from(MemoryEntriesTable)
          .where(
            and(
              eq(MemoryEntriesTable.status, status),
              ...(scopeFilter ? [scopeFilter] : []),
            ),
          )
          .orderBy(sql`${MemoryEntriesTable.updated_at} DESC`)
          .limit(limit)
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapRowToEntry)
      })

    return Service.of({ emitCandidate, promote, reject, listCandidates, events: eventsDequeue })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, never> = layer.pipe(
  Layer.provide(MemoryRepo.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

const mapRowToEntry = mapMemoryRowToEntry

export type { MemoryPayloadV1 }

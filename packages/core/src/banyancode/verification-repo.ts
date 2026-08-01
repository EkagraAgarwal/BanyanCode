export * as VerificationRepo from "./verification-repo"

import { and, desc, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { VerificationRunsTable } from "./verification.sql"

// Phase 6 (Verifier): the structured summary payload the verifier service
// writes when a run completes. Keeping this loose (the row column is JSON
// anyway) so adding fields like `warnings` later is non-breaking.
export interface VerificationSummary {
  readonly passed?: number
  readonly failed?: number
  readonly errored?: number
  readonly skipped?: number
}

export type VerificationKind = "typecheck" | "test" | "lint" | "compile"
export type VerificationStatus = "running" | "passed" | "failed" | "errored"

export interface VerificationRun {
  readonly id: number
  readonly kind: VerificationKind
  readonly target: string
  readonly status: VerificationStatus
  readonly startedAt: number
  readonly completedAt: number | undefined
  readonly durationMs: number | undefined
  readonly summary: VerificationSummary | undefined
  readonly rawOutput: string | undefined
  readonly cacheKey: string | undefined
}

export interface RecordStartInput {
  readonly kind: VerificationKind
  readonly target: string
  readonly cacheKey?: string
}

export interface RecordCompleteInput {
  readonly id: number
  readonly status: Exclude<VerificationStatus, "running">
  readonly durationMs: number
  readonly summary?: VerificationSummary
  readonly rawOutput?: string
}

export interface FindRecentInput {
  readonly kind?: VerificationKind
  readonly limit: number
}

export interface FindByCacheKeyInput {
  readonly cacheKey: string
}

export interface Interface {
  readonly recordStart: (input: RecordStartInput) => Effect.Effect<number, never, never>
  readonly recordComplete: (input: RecordCompleteInput) => Effect.Effect<VerificationRun, never, never>
  readonly findRecent: (input: FindRecentInput) => Effect.Effect<ReadonlyArray<VerificationRun>, never, never>
  readonly findByCacheKey: (input: FindByCacheKeyInput) => Effect.Effect<VerificationRun | undefined, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/VerificationRepo") {}

const mapRow = (row: typeof VerificationRunsTable.$inferSelect): VerificationRun => ({
  id: row.id,
  kind: row.kind as VerificationKind,
  target: row.target,
  status: row.status as VerificationStatus,
  startedAt: row.started_at,
  completedAt: row.completed_at ?? undefined,
  durationMs: row.duration_ms ?? undefined,
  summary: (row.summary as VerificationSummary | null) ?? undefined,
  rawOutput: row.raw_output ?? undefined,
  cacheKey: row.cache_key ?? undefined,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const recordStart = Effect.fn("VerificationRepo.recordStart")(function* (input: RecordStartInput) {
      const result = yield* db
        .insert(VerificationRunsTable)
        .values({
          kind: input.kind,
          target: input.target,
          status: "running",
          started_at: Math.floor(Date.now() / 1000),
          cache_key: input.cacheKey ?? null,
        })
        .returning({ id: VerificationRunsTable.id })
        .get()
        .pipe(Effect.orDie)
      return result.id
    })

    // Read-modify-write: complete a previously-started run. Wrapped in a single
    // transaction so the read-then-write can't interleave with a concurrent
    // complete from another fiber (which would otherwise double-write summary
    // counters or leave stale duration_ms). Pattern from AGENTS.md
    // "Read-modify-write in repos is a data-loss bug by default".
    const recordComplete = Effect.fn("VerificationRepo.recordComplete")(function* (input: RecordCompleteInput) {
      const now = Math.floor(Date.now() / 1000)
      const completedAt = now
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const existing = yield* tx
              .select()
              .from(VerificationRunsTable)
              .where(eq(VerificationRunsTable.id, input.id))
              .get()
              .pipe(Effect.orDie)
            if (!existing) {
              // Should never happen — recordStart always returns an id — but the
              // borrow checker insists we handle the undefined branch.
              return yield* Effect.die(new Error(`VerificationRepo.recordComplete: row id=${input.id} not found`))
            }
            yield* tx
              .update(VerificationRunsTable)
              .set({
                status: input.status,
                completed_at: completedAt,
                duration_ms: input.durationMs,
                summary: (input.summary ?? null) as never,
                raw_output: input.rawOutput ?? null,
              })
              .where(eq(VerificationRunsTable.id, input.id))
              .run()
              .pipe(Effect.orDie)
            const updated = yield* tx
              .select()
              .from(VerificationRunsTable)
              .where(eq(VerificationRunsTable.id, input.id))
              .get()
              .pipe(Effect.orDie)
            return mapRow(updated!)
          }),
        )
        .pipe(Effect.orDie)
    })

    const findRecent = Effect.fn("VerificationRepo.findRecent")(function* (input: FindRecentInput) {
      const limit = Math.max(1, Math.min(input.limit, 200))
      const rows = input.kind
        ? yield* db
            .select()
            .from(VerificationRunsTable)
            .where(eq(VerificationRunsTable.kind, input.kind))
            .orderBy(desc(VerificationRunsTable.completed_at))
            .limit(limit)
            .all()
            .pipe(Effect.orDie)
        : yield* db
            .select()
            .from(VerificationRunsTable)
            .orderBy(desc(VerificationRunsTable.completed_at))
            .limit(limit)
            .all()
            .pipe(Effect.orDie)
      return rows.map(mapRow)
    })

    // Returns the most recent completed run for the cache key. The verifier
    // service decides whether it's still fresh (within the cache TTL); this
    // repo just returns the row if one exists.
    const findByCacheKey = Effect.fn("VerificationRepo.findByCacheKey")(function* (input: FindByCacheKeyInput) {
      const row = yield* db
        .select()
        .from(VerificationRunsTable)
        .where(and(eq(VerificationRunsTable.cache_key, input.cacheKey), sql`${VerificationRunsTable.status} != 'running'`))
        .orderBy(desc(VerificationRunsTable.completed_at))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return row ? mapRow(row) : undefined
    })

    return Service.of({ recordStart, recordComplete, findRecent, findByCacheKey })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

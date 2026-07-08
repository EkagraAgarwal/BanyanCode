export * as TraceCollector from "./trace-collector"

import { and, eq, gte, sql } from "drizzle-orm"
import { Context, Effect, Layer, Queue, Ref } from "effect"
import { Database } from "../database/database"
import { CodegraphTracesTable } from "./codegraph-traces.sql"
import { CodegraphRepo } from "./codegraph-repo"
import type { CodegraphEdge, CodegraphNode } from "./types"

const TRACE_BUCKET_MS = 60_000

export type TraceEvent = {
  readonly traceName: string
  readonly parentTraceName: string | null
  readonly observedAt: number
}

const bucketFor = (observedAt: number): number => Math.floor(observedAt / TRACE_BUCKET_MS)

const newTraceID = (event: TraceEvent): string =>
  `trace:${event.traceName}:${event.observedAt}:${Math.random().toString(36).slice(2, 10)}`

export interface Interface {
  readonly record: (event: TraceEvent) => Effect.Effect<void, never, never>
  readonly observedEdges: (input: { since?: number; traceName?: string }) => Effect.Effect<CodegraphEdge[], never, never>
  readonly observedCallers: (input: { nodeID: string; since?: number }) => Effect.Effect<CodegraphNode[], never, never>
  readonly traceCount: () => Effect.Effect<number, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/TraceCollector") {}

const unknownIDFor = (name: string): string => `unknown:Trace:${name}`

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const repo = yield* CodegraphRepo.Service

    const queue = yield* Queue.dropping<TraceEvent>(1024).pipe(Effect.orDie)
    yield* Effect.addFinalizer(() => Queue.shutdown(queue))

    const resolveNameCache = yield* Ref.make<Map<string, string>>(new Map())
    const resolveName = (name: string): Effect.Effect<string, never, never> =>
      Effect.gen(function* () {
        const cached = yield* Ref.get(resolveNameCache)
        const hit = cached.get(name)
        if (hit !== undefined) return hit
        const matches = yield* repo.queryNodes({ function: name })
        const nodeID = matches[0]?.id ?? unknownIDFor(name)
        yield* Ref.update(resolveNameCache, (m) => new Map(m).set(name, nodeID))
        return nodeID
      })

    const persist = (event: TraceEvent): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const toNodeID = yield* resolveName(event.traceName)
        const fromNodeID = event.parentTraceName ? yield* resolveName(event.parentTraceName) : null
        const bucket = bucketFor(event.observedAt)
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(CodegraphTracesTable)
                .values({
                  id: newTraceID(event),
                  trace_name: event.traceName,
                  from_node_id: fromNodeID,
                  to_node_id: toNodeID,
                  observed_at: event.observedAt,
                  observed_at_bucket: bucket,
                })
                .onConflictDoNothing()
                .run()
                .pipe(Effect.orDie)
            }),
          )
          .pipe(Effect.orDie)
      })

    yield* Effect.forkDetach(
      Effect.gen(function* () {
        yield* Queue.take(queue).pipe(
          Effect.tap((event) => persist(event)),
          Effect.forever,
        )
      }).pipe(
        Effect.catchCause(() => Effect.void),
      ),
    )

    const observedEdges = (input: { since?: number; traceName?: string }): Effect.Effect<CodegraphEdge[], never, never> =>
      Effect.gen(function* () {
        const conditions = []
        if (input.since !== undefined) conditions.push(gte(CodegraphTracesTable.observed_at, input.since))
        if (input.traceName) conditions.push(eq(CodegraphTracesTable.trace_name, input.traceName))
        const rows = yield* db
          .select({
            trace_name: CodegraphTracesTable.trace_name,
            from_node_id: CodegraphTracesTable.from_node_id,
            to_node_id: CodegraphTracesTable.to_node_id,
            observed_count: sql<number>`COUNT(*)`,
          })
          .from(CodegraphTracesTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .groupBy(
            CodegraphTracesTable.trace_name,
            CodegraphTracesTable.from_node_id,
            CodegraphTracesTable.to_node_id,
          )
          .all()
          .pipe(Effect.orDie)
        return rows
          .filter((row): row is typeof row & { from_node_id: string } => row.from_node_id !== null)
          .map((row, idx) => ({
            id: `runtime:${row.trace_name}:${row.from_node_id}:${row.to_node_id}:${idx}`,
            fromNodeID: row.from_node_id,
            toNodeID: row.to_node_id,
            kind: "calls" as const,
          }))
      })

    const observedCallers = (input: { nodeID: string; since?: number }): Effect.Effect<CodegraphNode[], never, never> =>
      Effect.gen(function* () {
        const conditions = [eq(CodegraphTracesTable.to_node_id, input.nodeID)]
        if (input.since !== undefined) conditions.push(gte(CodegraphTracesTable.observed_at, input.since))
        const rows = yield* db
          .selectDistinct({ from_node_id: CodegraphTracesTable.from_node_id })
          .from(CodegraphTracesTable)
          .where(and(...conditions))
          .all()
          .pipe(Effect.orDie)
        const ids = rows.map((r) => r.from_node_id).filter((id): id is string => id !== null)
        if (ids.length === 0) return []
        return yield* repo.nodesByIDs(ids)
      })

    const traceCount = (): Effect.Effect<number, never, never> =>
      Effect.gen(function* () {
        const row = yield* db
          .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM codegraph_traces`)
          .pipe(Effect.orDie)
        return row?.c ?? 0
      })

    const record = (event: TraceEvent): Effect.Effect<void, never, never> =>
      Queue.offer(queue, event).pipe(Effect.ignore)

    return Service.of({ record, observedEdges, observedCallers, traceCount })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(CodegraphRepo.defaultLayer))
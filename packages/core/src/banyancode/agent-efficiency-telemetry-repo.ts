export * as AgentEfficiencyTelemetryRepo from "./agent-efficiency-telemetry-repo"

import { and, asc, eq, gte, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { AgentEfficiencyTelemetryTable } from "./agent-efficiency-telemetry.sql"
import type { AgentEfficiencyEvent } from "./agent-efficiency-telemetry"

export interface Interface {
  readonly append: (event: AgentEfficiencyEvent) => Effect.Effect<void, never, never>
  readonly list: (input?: { readonly runID?: string; readonly sessionID?: string; readonly since?: number }) => Effect.Effect<readonly AgentEfficiencyEvent[], never, never>
  readonly count: () => Effect.Effect<number, never, never>
  readonly prune: (input: { readonly retentionMs: number; readonly maxEvents: number }) => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/AgentEfficiencyTelemetryRepo") {}

const toRow = (event: AgentEfficiencyEvent): typeof AgentEfficiencyTelemetryTable.$inferInsert => ({
  event_id: event.eventID,
  schema_version: event.schemaVersion,
  event_type: event.eventType,
  occurred_at: event.occurredAt,
  run_id: event.runID,
  session_id: event.sessionID,
  parent_session_id: event.parentSessionID,
  root_session_id: event.rootSessionID,
  agent_instance_id: event.agentInstanceID,
  agent_role: event.agentRole,
  depth: event.depth,
  task_id: event.taskID,
  benchmark_id: event.benchmarkID,
  experiment_id: event.experimentID,
  experiment_variant: event.experimentVariant,
  model_call_id: event.modelCallID,
  tool_call_id: event.toolCallID,
  finding_id: event.findingID,
  parent_event_id: event.parentEventID,
  status: event.status,
  duration_ms: event.durationMs,
  error_category: event.errorCategory,
  metadata: event.metadata === undefined ? undefined : { _v: 1, data: event.metadata },
})

const fromRow = (row: typeof AgentEfficiencyTelemetryTable.$inferSelect): AgentEfficiencyEvent => {
  const metadata = row.metadata
  return {
    schemaVersion: 1,
    eventID: row.event_id,
    eventType: row.event_type as AgentEfficiencyEvent["eventType"],
    occurredAt: row.occurred_at,
    runID: row.run_id,
    sessionID: row.session_id ?? undefined,
    parentSessionID: row.parent_session_id ?? undefined,
    rootSessionID: row.root_session_id ?? undefined,
    agentInstanceID: row.agent_instance_id ?? undefined,
    agentRole: row.agent_role ?? undefined,
    depth: row.depth ?? undefined,
    taskID: row.task_id ?? undefined,
    benchmarkID: row.benchmark_id ?? undefined,
    experimentID: row.experiment_id ?? undefined,
    experimentVariant: row.experiment_variant ?? undefined,
    modelCallID: row.model_call_id ?? undefined,
    toolCallID: row.tool_call_id ?? undefined,
    findingID: row.finding_id ?? undefined,
    parentEventID: row.parent_event_id ?? undefined,
    status: row.status as AgentEfficiencyEvent["status"],
    durationMs: row.duration_ms ?? undefined,
    errorCategory: row.error_category ?? undefined,
    metadata: metadata?.data,
  }
}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const { db } = yield* Database.Service
  const append = (event: AgentEfficiencyEvent) => db.insert(AgentEfficiencyTelemetryTable).values(toRow(event)).onConflictDoNothing().run().pipe(Effect.orDie)
  const list = (input?: { readonly runID?: string; readonly sessionID?: string; readonly since?: number }) => Effect.gen(function* () {
    const filters = [input?.runID ? eq(AgentEfficiencyTelemetryTable.run_id, input.runID) : undefined, input?.sessionID ? eq(AgentEfficiencyTelemetryTable.session_id, input.sessionID) : undefined, input?.since === undefined ? undefined : gte(AgentEfficiencyTelemetryTable.occurred_at, input.since)].filter((x): x is NonNullable<typeof x> => x !== undefined)
    const rows = yield* db
      .select()
      .from(AgentEfficiencyTelemetryTable)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(AgentEfficiencyTelemetryTable.occurred_at), asc(AgentEfficiencyTelemetryTable.event_id))
      .all()
      .pipe(Effect.orDie)
    return rows.map(fromRow)
  })
  const count = () => db.select({ count: sql<number>`count(*)` }).from(AgentEfficiencyTelemetryTable).get().pipe(Effect.map((row) => row?.count ?? 0), Effect.orDie)
  const prune = ({ retentionMs, maxEvents }: { retentionMs: number; maxEvents: number }) => Effect.gen(function* () {
    yield* db.transaction((tx) => Effect.gen(function* () {
      const nonTerminal = sql`(status IS NULL OR status NOT IN ('succeeded', 'failed', 'aborted')) AND event_type NOT LIKE '%.finished' AND event_type NOT LIKE '%.failed' AND event_type NOT LIKE '%.aborted' AND event_type != 'outcome.recorded'`
      yield* tx.run(sql`DELETE FROM agent_efficiency_telemetry WHERE occurred_at <= ${Date.now() - retentionMs} AND ${nonTerminal}`)
      // maxEvents bounds verbose/non-terminal events; terminal outcomes are never discarded.
      yield* tx.run(sql`DELETE FROM agent_efficiency_telemetry WHERE ${nonTerminal} AND event_id NOT IN (SELECT event_id FROM agent_efficiency_telemetry WHERE ${nonTerminal} ORDER BY occurred_at DESC, event_id DESC LIMIT ${maxEvents})`)
    })).pipe(Effect.orDie)
  })
  return Service.of({ append, list, count, prune })
}))

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

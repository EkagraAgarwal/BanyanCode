/**
 * BanyanCode Memory Projection (Phase 4).
 *
 * Derivative views over the canonical memory entries. Each projection is a
 * small, regenerable summary of what durable memory currently says. None of
 * these are stored — they are computed on demand and always reflect the
 * latest state of `memory_entries`.
 *
 * Projections:
 *   - projectSummary   group of { kind, title, body } for active entries
 *                      grouped by `kind`
 *   - activeDecisions  list of active decision/architecture entries
 *   - activeWarnings   list of active warning entries (sorted recency)
 *   - recentChanges    list of active entries updated in the last 7 days
 *   - openTodos        list of active todo entries
 *   - agentWorkingNotes per-agent condensed view (titles + bodies for the
 *                      given agentID)
 *
 * All projections are deterministic given the entries table. They are pure
 * `Effect.succeed` reads — no event publishing, no DB writes, no caching.
 */

import { Context, Effect, Layer } from "effect"
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm"
import type { MemoryEntry } from "./types"
import { MemoryRepo } from "./memory-repo"
import { MemoryEntriesTable } from "./memory.sql"
import { unwrapMemoryValue } from "./memory-payload"
import { Database } from "../database/database"

export interface ProjectSummarySection {
  kind: MemoryEntry["kind"]
  entries: MemoryEntry[]
}

export interface ProjectSummary {
  totalActive: number
  byKind: ProjectSummarySection[]
  generatedAt: number
}

export interface AgentWorkingNotes {
  agentID: string
  entries: MemoryEntry[]
  generatedAt: number
}

export interface ActiveList {
  entries: MemoryEntry[]
  totalActive: number
  generatedAt: number
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Banyan/MemoryProjection") {}

export interface Interface {
  readonly projectSummary: (input?: {
    scope?: "global" | "session"
    sessionID?: string
  }) => Effect.Effect<ProjectSummary, never, never>
  readonly activeDecisions: (input?: {
    scope?: "global" | "session"
    sessionID?: string
  }) => Effect.Effect<ActiveList, never, never>
  readonly activeWarnings: (input?: {
    scope?: "global" | "session"
    sessionID?: string
  }) => Effect.Effect<ActiveList, never, never>
  readonly recentChanges: (input?: {
    scope?: "global" | "session"
    sessionID?: string
    withinMs?: number
  }) => Effect.Effect<ActiveList, never, never>
  readonly openTodos: (input?: {
    scope?: "global" | "session"
    sessionID?: string
  }) => Effect.Effect<ActiveList, never, never>
  readonly agentWorkingNotes: (input: { agentID: string; scope?: "global" | "session" }) => Effect.Effect<AgentWorkingNotes, never, never>
}

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

const ACTIVE_LIST_KINDS = {
  decisions: ["decision", "architecture", "constraint"] as const,
  warnings: ["warning", "failure"] as const,
  todos: ["todo"] as const,
}

const scopeWhereSql = (scope: "global" | "session" | undefined, sessionID: string | undefined) => {
  if (!scope) return sql`1=1`
  if (scope === "global") return sql`\`scope\` = 'global'`
  return sql`\`scope\` = 'session' AND \`session_id\` = ${sessionID ?? ""}`
}

export const layer: Layer.Layer<Service, never, MemoryRepo.Service | Database.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (!banyancodeEnabled()) {
      const empty: ProjectSummary = { totalActive: 0, byKind: [], generatedAt: 0 }
      return Service.of({
        projectSummary: () => Effect.succeed(empty),
        activeDecisions: () => Effect.succeed({ entries: [], totalActive: 0, generatedAt: 0 }),
        activeWarnings: () => Effect.succeed({ entries: [], totalActive: 0, generatedAt: 0 }),
        recentChanges: () => Effect.succeed({ entries: [], totalActive: 0, generatedAt: 0 }),
        openTodos: () => Effect.succeed({ entries: [], totalActive: 0, generatedAt: 0 }),
        agentWorkingNotes: () => Effect.succeed({ agentID: "", entries: [], generatedAt: 0 }),
      })
    }

    const { db } = yield* Database.Service

    const fetchActiveByKind = Effect.fn("MemoryProjection.fetchActiveByKind")(function* (
      kinds: readonly string[],
      scope: "global" | "session" | undefined,
      sessionID: string | undefined,
    ) {
      const whereClause = sql`${eq(MemoryEntriesTable.status, "active")} AND ${inArray(MemoryEntriesTable.kind, kinds as string[])} AND ${scopeWhereSql(scope, sessionID)}`
      return yield* db
        .select()
        .from(MemoryEntriesTable)
        .where(whereClause)
        .orderBy(desc(MemoryEntriesTable.updated_at))
        .all()
        .pipe(Effect.orDie)
    })

    const countActive = Effect.fn("MemoryProjection.countActive")(function* (
      scope: "global" | "session" | undefined,
      sessionID: string | undefined,
    ) {
      const row = yield* db
        .get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM \`memory_entries\`
          WHERE \`status\` = 'active' AND ${scopeWhereSql(scope, sessionID)}
        `)
        .pipe(Effect.orDie)
      return row?.c ?? 0
    })

    const mapRows = (rows: typeof MemoryEntriesTable.$inferSelect[]): MemoryEntry[] =>
      rows.map((r) => ({
        id: r.id,
        key: r.key,
        value: r.value,
        context: r.context ?? undefined,
        tags: r.tags,
        scope: r.scope as "global" | "session",
        sessionID: r.session_id ?? undefined,
        createdAt: r.created_at,
        expiresAt: r.expires_at ?? undefined,
        agentID: r.agent_id ?? undefined,
        version: r.version,
        updatedAt: r.updated_at,
        namespace: r.namespace ?? undefined,
        kind: r.kind ?? undefined,
        title: r.title ?? undefined,
        body: r.body ?? undefined,
        status: r.status ?? undefined,
      }))

    const projectSummary: Interface["projectSummary"] = (input = {}) =>
      Effect.gen(function* () {
        const scope = input.scope
        const sessionID = input.sessionID
        const scopeClause = scopeWhereSql(scope, sessionID)
        const rows = yield* db
          .select({ kind: MemoryEntriesTable.kind })
          .from(MemoryEntriesTable)
          .where(sql`status = 'active' AND ${scopeClause} AND kind IS NOT NULL`)
          .all()
          .pipe(Effect.orDie)

        const kindsSeen = new Set<string>()
        for (const r of rows) if (r.kind) kindsSeen.add(r.kind)
        const kinds = Array.from(kindsSeen).sort()

        const byKind: ProjectSummarySection[] = []
        for (const kind of kinds) {
          const whereClause = sql`${eq(MemoryEntriesTable.status, "active")} AND ${eq(MemoryEntriesTable.kind, kind)} AND ${scopeClause}`
          const kindRows = yield* db
            .select()
            .from(MemoryEntriesTable)
            .where(whereClause)
            .orderBy(desc(MemoryEntriesTable.updated_at))
            .all()
            .pipe(Effect.orDie)
          byKind.push({ kind: kind as MemoryEntry["kind"], entries: mapRows(kindRows) })
        }

        const totalActive = yield* countActive(scope, sessionID)

        return {
          totalActive,
          byKind,
          generatedAt: Date.now(),
        }
      })

    const activeDecisions: Interface["activeDecisions"] = (input = {}) =>
      Effect.gen(function* () {
        const rows = yield* fetchActiveByKind(ACTIVE_LIST_KINDS.decisions, input.scope, input.sessionID)
        const totalActive = yield* countActive(input.scope, input.sessionID)
        return { entries: mapRows(rows), totalActive, generatedAt: Date.now() }
      })

    const activeWarnings: Interface["activeWarnings"] = (input = {}) =>
      Effect.gen(function* () {
        const rows = yield* fetchActiveByKind(ACTIVE_LIST_KINDS.warnings, input.scope, input.sessionID)
        const totalActive = yield* countActive(input.scope, input.sessionID)
        return { entries: mapRows(rows), totalActive, generatedAt: Date.now() }
      })

    const recentChanges: Interface["recentChanges"] = (input = {}) =>
      Effect.gen(function* () {
        const within = input.withinMs ?? 7 * 86_400_000
        const since = Date.now() - within
        const whereClause = sql`${eq(MemoryEntriesTable.status, "active")} AND ${gte(MemoryEntriesTable.updated_at, since)} AND ${scopeWhereSql(input.scope, input.sessionID)}`
        const rows = yield* db
          .select()
          .from(MemoryEntriesTable)
          .where(whereClause)
          .orderBy(desc(MemoryEntriesTable.updated_at))
          .all()
          .pipe(Effect.orDie)
        const totalActive = yield* countActive(input.scope, input.sessionID)
        return { entries: mapRows(rows), totalActive, generatedAt: Date.now() }
      })

    const openTodos: Interface["openTodos"] = (input = {}) =>
      Effect.gen(function* () {
        const rows = yield* fetchActiveByKind(ACTIVE_LIST_KINDS.todos, input.scope, input.sessionID)
        const totalActive = yield* countActive(input.scope, input.sessionID)
        return { entries: mapRows(rows), totalActive, generatedAt: Date.now() }
      })

    const agentWorkingNotes: Interface["agentWorkingNotes"] = (input) =>
      Effect.gen(function* () {
        const whereClause = sql`${eq(MemoryEntriesTable.status, "active")} AND ${input.scope ? eq(MemoryEntriesTable.scope, input.scope) : eq(MemoryEntriesTable.scope, "global")} AND ${eq(MemoryEntriesTable.agent_id, input.agentID)}`
        const rows = yield* db
          .select()
          .from(MemoryEntriesTable)
          .where(whereClause)
          .orderBy(desc(MemoryEntriesTable.updated_at))
          .all()
          .pipe(Effect.orDie)
        return {
          agentID: input.agentID,
          entries: mapRows(rows).map((e) => {
            const payload = unwrapMemoryValue(e.value, e.key)
            return {
              ...e,
              title: payload.title,
              body: payload.body,
              kind: payload.kind,
            }
          }),
          generatedAt: Date.now(),
        }
      })

    return Service.of({
      projectSummary,
      activeDecisions,
      activeWarnings,
      recentChanges,
      openTodos,
      agentWorkingNotes,
    })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, never> = layer.pipe(
  Layer.provide(MemoryRepo.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export type { MemoryEntry }

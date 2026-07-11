export * as MemoryRepo from "./memory-repo"

import { and, eq, isNotNull, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { MemoryEntriesTable } from "./memory.sql"
import type { MemoryEntry } from "./types"
import { NotFoundError, StaleWriteError } from "./types"
import { encodeMemoryValue, normalizeMemoryValue, looksLikeMemoryPayload, unwrapMemoryValue, type MemoryPayloadV1 } from "./memory-payload"

export interface PutInput {
  id: string
  key: string
  value: unknown
  context?: string
  tags?: string[]
  scope: "global" | "session"
  sessionID?: string
  expiresAt?: number
  agentID?: string
}

export interface UpdateInput {
  id: string
  expectedVersion: number
  value?: unknown
  agentID?: string
  context?: string
  tags?: string[]
}

/** Optional Phase-1a fields callers can pin to bypass auto-derivation. */
export interface PutOverrides {
  kind?: string
  title?: string
  body?: string
  status?: string
}

export interface ForgetByKeyInput {
  key: string
  scope: "global" | "session"
  sessionID?: string
}

export interface SearchRankedInput {
  query: string
  limit?: number
  scope?: "global" | "session"
  sessionID?: string
  status?: string
  kind?: string
}

export interface SearchRankedResult {
  entries: MemoryEntry[]
  totalHits: number
}

export interface Interface {
  readonly put: (
    input: PutInput & { createdAt?: number; overrides?: PutOverrides },
  ) => Effect.Effect<void, never, never>
  readonly get: (id: string) => Effect.Effect<MemoryEntry | undefined, never, never>
  readonly list: (scope: "global" | "session", sessionID?: string) => Effect.Effect<MemoryEntry[], never, never>
  readonly forget: (id: string) => Effect.Effect<void, never, never>
  readonly forgetByKey: (input: ForgetByKeyInput) => Effect.Effect<number, never, never>
  readonly search: (scope: "global" | "session", sessionID: string | undefined, key: string) => Effect.Effect<MemoryEntry[], never, never>
  readonly searchRanked: (input: SearchRankedInput) => Effect.Effect<SearchRankedResult, never, never>
  readonly vacuum: () => Effect.Effect<number, never, never>
  readonly update: (
    input: UpdateInput & { overrides?: PutOverrides },
  ) => Effect.Effect<MemoryEntry, NotFoundError | StaleWriteError, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Banyan/MemoryRepo") {}

const deriveNamespace = (key: string): string | null => {
  const colonIndex = key.indexOf(":")
  return colonIndex > 0 ? key.slice(0, colonIndex) : null
}

/**
 * Decide how to interpret the caller-supplied `value`. Returns the value to
 * persist (envelope-wrapped when needed) plus the denormalized columns.
 */
const normalizePut = (key: string, value: unknown): { stored: unknown; kind: string; title: string; body: string; status: string } => {
  const fallbackTitle = key || "memory"
  if (looksLikeMemoryPayload(value)) {
    const payload = unwrapMemoryValue(value, fallbackTitle)
    return {
      stored: encodeMemoryValue(payload),
      kind: payload.kind,
      title: payload.title,
      body: payload.body,
      status: payload.status,
    }
  }
  // Legacy / arbitrary payload: wrap as an observation so existing callers
  // keep working and future readers get a typed shape.
  const { payload, encoded } = normalizeMemoryValue(value, fallbackTitle)
  return {
    stored: encoded,
    kind: payload.kind,
    title: payload.title,
    body: payload.body,
    status: payload.status,
  }
}

const denormFromValue = (value: unknown, fallbackTitle: string): Pick<MemoryEntry, "kind" | "title" | "body" | "status"> => {
  const payload: MemoryPayloadV1 = unwrapMemoryValue(value, fallbackTitle)
  return { kind: payload.kind, title: payload.title, body: payload.body, status: payload.status }
}

const mapRowToEntry = (row: typeof MemoryEntriesTable.$inferSelect): MemoryEntry => ({
  id: row.id,
  key: row.key,
  value: row.value,
  context: row.context ?? undefined,
  tags: row.tags,
  scope: row.scope as "global" | "session",
  sessionID: row.session_id ?? undefined,
  createdAt: row.created_at,
  expiresAt: row.expires_at ?? undefined,
  agentID: row.agent_id ?? undefined,
  version: row.version,
  updatedAt: row.updated_at,
  namespace: row.namespace ?? undefined,
  kind: row.kind ?? undefined,
  title: row.title ?? undefined,
  body: row.body ?? undefined,
  status: row.status ?? undefined,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const put = Effect.fn("MemoryRepo.put")(
      function* (input: PutInput & { createdAt?: number; overrides?: PutOverrides }) {
        const now = input.createdAt ?? Date.now()
        const namespace = deriveNamespace(input.key)
        const normalized = normalizePut(input.key, input.value)
        const kind = input.overrides?.kind ?? normalized.kind
        const title = input.overrides?.title ?? normalized.title
        const body = input.overrides?.body ?? normalized.body
        const status = input.overrides?.status ?? normalized.status

        yield* db
          .insert(MemoryEntriesTable)
          .values({
            id: input.id,
            key: input.key,
            value: normalized.stored,
            context: input.context,
            tags: input.tags ?? [],
            scope: input.scope,
            session_id: input.sessionID,
            created_at: now,
            expires_at: input.expiresAt,
            agent_id: input.agentID,
            version: 1,
            updated_at: now,
            namespace,
            kind,
            title,
            body,
            status,
          })
          .onConflictDoUpdate({
            target: MemoryEntriesTable.id,
            set: {
              key: input.key,
              value: normalized.stored,
              context: input.context,
              tags: input.tags ?? [],
              scope: input.scope,
              session_id: input.sessionID,
              expires_at: input.expiresAt,
              agent_id: input.agentID,
              version: sql`${MemoryEntriesTable.version} + 1`,
              updated_at: now,
              namespace,
              kind,
              title,
              body,
              status,
            },
          })
          .run()
          .pipe(Effect.orDie)
      },
    )

    const get = Effect.fn("MemoryRepo.get")(function* (id: string) {
      const row = yield* db
        .select()
        .from(MemoryEntriesTable)
        .where(eq(MemoryEntriesTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return mapRowToEntry(row)
    })

    const list = Effect.fn("MemoryRepo.list")(function* (scope: "global" | "session", sessionID?: string) {
      const rows = yield* db
        .select()
        .from(MemoryEntriesTable)
        .where(
          scope === "global"
            ? eq(MemoryEntriesTable.scope, "global")
            : and(eq(MemoryEntriesTable.scope, "session"), eq(MemoryEntriesTable.session_id, sessionID ?? "")),
        )
        .all()
        .pipe(Effect.orDie)
      return rows.map(mapRowToEntry)
    })

    const forget = Effect.fn("MemoryRepo.forget")(function* (id: string) {
      yield* db.delete(MemoryEntriesTable).where(eq(MemoryEntriesTable.id, id)).run().pipe(Effect.orDie)
    })

    const forgetByKey = Effect.fn("MemoryRepo.forgetByKey")(function* (input: ForgetByKeyInput) {
      const result = yield* db
        .delete(MemoryEntriesTable)
        .where(
          input.scope === "global"
            ? and(eq(MemoryEntriesTable.scope, "global"), eq(MemoryEntriesTable.key, input.key))
            : and(
                eq(MemoryEntriesTable.scope, "session"),
                eq(MemoryEntriesTable.session_id, input.sessionID ?? ""),
                eq(MemoryEntriesTable.key, input.key),
              ),
        )
        .returning()
        .run()
        .pipe(Effect.orDie)
      return result.length
    })

    const search = Effect.fn("MemoryRepo.search")(function* (
      scope: "global" | "session",
      sessionID: string | undefined,
      key: string,
    ) {
      const rows = yield* db
        .select()
        .from(MemoryEntriesTable)
        .where(
          scope === "global"
            ? and(eq(MemoryEntriesTable.scope, "global"), eq(MemoryEntriesTable.key, key))
            : and(
                eq(MemoryEntriesTable.scope, "session"),
                eq(MemoryEntriesTable.session_id, sessionID ?? ""),
                eq(MemoryEntriesTable.key, key),
              ),
        )
        .all()
        .pipe(Effect.orDie)
      return rows.map(mapRowToEntry)
    })

    /**
     * BM25-ranked full-text search. Falls back to JS keyword search if the
     * FTS table is missing (e.g. before migration applied).
     *
     * The Drizzle typed builder doesn't know about FTS5 virtual tables, so
     * this issues raw SQL via `db.all<...>(sql\`...\`)` — same pattern as
     * `codegraph_fts` in codegraph-repo.ts. Parameter values are
     * interpolated through the `sql` tagged template (no string concat)
     * so they're always bound, never spliced.
     */
    const searchRanked: Interface["searchRanked"] = (input) => {
      return Effect.gen(function* () {
        const limit = Math.max(1, Math.min(input.limit ?? 25, 100))
        const ftsQuery = input.query.trim()
        if (!ftsQuery) return { entries: [], totalHits: 0 }

        // Sanitize the FTS5 query: wrap each whitespace-delimited token in
        // double quotes so punctuation in the user query doesn't break the
        // FTS5 expression. Stemming still happens via the unicode61 tokenizer.
        const tokens = ftsQuery
          .split(/\s+/)
          .map((t) => t.replace(/"/g, ""))
          .filter((t) => t.length > 0)
        if (tokens.length === 0) return { entries: [], totalHits: 0 }
        const ftsExpression = tokens.map((t) => `"${t}"`).join(" ")

        // Build optional filter clauses via `sql` templates so params are
        // bound, not spliced.
        const filterChunks: ReturnType<typeof sql>[] = []
        if (input.scope) {
          filterChunks.push(sql`AND \`memory_entries\`.\`scope\` = ${input.scope}`)
          if (input.scope === "session") {
            filterChunks.push(sql`AND \`memory_entries\`.\`session_id\` = ${input.sessionID ?? ""}`)
          }
        }
        if (input.status) {
          filterChunks.push(sql`AND \`memory_entries\`.\`status\` = ${input.status}`)
        }
        if (input.kind) {
          filterChunks.push(sql`AND \`memory_entries\`.\`kind\` = ${input.kind}`)
        }
        const filterSql = sql.join(filterChunks, sql` `)

        type RankedRow = typeof MemoryEntriesTable.$inferSelect

        try {
          const rankedRows = yield* db
            .all<RankedRow>(sql`
              SELECT \`memory_entries\`.* FROM \`memory_entries\`
              INNER JOIN \`memory_entries_fts\` ON \`memory_entries_fts\`.\`rowid\` = \`memory_entries\`.\`rowid\`
              WHERE \`memory_entries_fts\` MATCH ${ftsExpression} ${filterSql}
              ORDER BY bm25(\`memory_entries_fts\`)
              LIMIT ${limit}
            `)
            .pipe(Effect.orDie)

          const totalRow = yield* db
            .get<{ c: number }>(sql`
              SELECT COUNT(*) AS c FROM \`memory_entries\`
              INNER JOIN \`memory_entries_fts\` ON \`memory_entries_fts\`.\`rowid\` = \`memory_entries\`.\`rowid\`
              WHERE \`memory_entries_fts\` MATCH ${ftsExpression} ${filterSql}
            `)
            .pipe(Effect.orDie)

          return { entries: rankedRows.map(mapRowToEntry), totalHits: totalRow?.c ?? 0 }
        } catch {
          // FTS table missing or query malformed — fall back to a degraded
          // in-memory keyword scan against `body` + `key`. The tool wrapper
          // layer surfaces `degraded: true` for this case via the shape of
          // what we return (entries without `bm25` ranking).
          const all = yield* db
            .select()
            .from(MemoryEntriesTable)
            .all()
            .pipe(Effect.orDie)
          const matched = all
            .map(mapRowToEntry)
            .filter((e) => {
              if (input.scope && e.scope !== input.scope) return false
              if (input.scope === "session" && input.sessionID && e.sessionID !== input.sessionID) return false
              if (input.status && e.status !== input.status) return false
              if (input.kind && e.kind !== input.kind) return false
              const hay = [e.key, e.title ?? "", e.body ?? "", e.kind ?? ""].join(" ").toLowerCase()
              return tokens.every((t) => hay.includes(t.toLowerCase()))
            })
            .slice(0, limit)
          return { entries: matched, totalHits: matched.length }
        }
      })
    }

    const update: Interface["update"] = (input) => {
      return db.transaction((tx) =>
        Effect.gen(function* () {
          const now = Date.now()

          // First, get the current row to check its version
          const currentRow = yield* tx
            .select()
            .from(MemoryEntriesTable)
            .where(eq(MemoryEntriesTable.id, input.id))
            .get()
            .pipe(Effect.orDie)

          if (!currentRow) {
            return yield* Effect.fail(new NotFoundError({ id: input.id }))
          }

          if (currentRow.version !== input.expectedVersion) {
            return yield* Effect.fail(
              new StaleWriteError({
                id: input.id,
                expectedVersion: input.expectedVersion,
                currentVersion: currentRow.version,
              }),
            )
          }

          // Re-normalize value if caller passed a new one so denorm columns
          // stay in sync. Otherwise, keep the existing ones.
          let nextKind = currentRow.kind
          let nextTitle = currentRow.title
          let nextBody = currentRow.body
          let nextStatus = currentRow.status
          let nextValue = input.value ?? currentRow.value

          if (input.value !== undefined) {
            const denorm = denormFromValue(input.value, currentRow.key)
            nextKind = input.overrides?.kind ?? denorm.kind ?? nextKind
            nextTitle = input.overrides?.title ?? denorm.title ?? nextTitle
            nextBody = input.overrides?.body ?? denorm.body ?? nextBody
            nextStatus = input.overrides?.status ?? denorm.status ?? nextStatus
            // Always re-store the value as an envelope so legacy raw blobs
            // get wrapped on first update.
            const payload = unwrapMemoryValue(input.value, currentRow.key)
            nextValue = encodeMemoryValue(payload)
          } else if (input.overrides) {
            nextKind = input.overrides.kind ?? nextKind
            nextTitle = input.overrides.title ?? nextTitle
            nextBody = input.overrides.body ?? nextBody
            nextStatus = input.overrides.status ?? nextStatus
          }

          yield* tx
            .update(MemoryEntriesTable)
            .set({
              value: nextValue,
              context: input.context ?? currentRow.context,
              tags: input.tags ?? currentRow.tags,
              version: currentRow.version + 1,
              updated_at: now,
              agent_id: input.agentID ?? currentRow.agent_id,
              kind: nextKind,
              title: nextTitle,
              body: nextBody,
              status: nextStatus,
            })
            .where(and(eq(MemoryEntriesTable.id, input.id), eq(MemoryEntriesTable.version, input.expectedVersion)))
            .run()
            .pipe(Effect.orDie)

          const updatedRow = yield* tx
            .select()
            .from(MemoryEntriesTable)
            .where(eq(MemoryEntriesTable.id, input.id))
            .get()
            .pipe(Effect.orDie)

          return mapRowToEntry(updatedRow!)
        }),
      ).pipe(
        Effect.catchIf(
          (err): err is any => (err as any)._tag === "SqlError",
          (err) => Effect.die(err),
        ),
      )
    }

    const vacuum = Effect.fn("MemoryRepo.vacuum")(function* () {
      const now = Date.now()
      const result = yield* db
        .delete(MemoryEntriesTable)
        .where(and(isNotNull(MemoryEntriesTable.expires_at), lt(MemoryEntriesTable.expires_at, now)))
        .returning()
        .run()
        .pipe(Effect.orDie)
      return result.length
    })

    return Service.of({ put, get, list, forget, forgetByKey, search, searchRanked, vacuum, update })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
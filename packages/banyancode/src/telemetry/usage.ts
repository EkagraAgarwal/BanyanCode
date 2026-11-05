export * as ToolUsage from "./usage.js"

import { Cause, Effect } from "effect"
import type { Storage } from "../storage/index.js"

// Port of v1 `AdaptedCatalog.recordUsage` + `CodegraphRepo.listToolUsage`
// against the v2 plugin database.
//
// `codegraph_tool_usage` stays the lifetime rollup (tool_id PK). Per-session
// attribution lives in `tool_usage_session` (session_id, tool_id) PK, because a
// single `session_id` column on the lifetime row could only ever name the first
// session that used a tool. `gateway_usage` is the gateway's own ledger: which
// call was swapped into which tool, per session and route.

export interface ToolUsageRow {
  readonly toolId: string
  readonly useCount: number
  readonly lastUsedAt: number
}

export interface ToolUsageResult {
  readonly tools: readonly ToolUsageRow[]
}

export type GatewayRouteName = "swapped" | "fallback" | "augmented" | "direct"

export interface GatewayUsageRow {
  readonly fromTool: string
  readonly toTool: string
  readonly route: GatewayRouteName
  readonly useCount: number
  readonly bytesSaved: number
  readonly lastUsedAt: number
}

export interface GatewayUsageSummary {
  readonly swapped: number
  readonly fallback: number
  readonly augmented: number
  readonly direct: number
  readonly bytesSaved: number
}

export interface GatewayUsageResult {
  readonly rows: readonly GatewayUsageRow[]
  readonly summary: GatewayUsageSummary
}

/** Never fails; usage accounting must not affect a completed tool call. */
export const recordToolUsage = (
  storage: Storage.Interface,
  toolID: string,
  sessionID?: string,
): Effect.Effect<void, never, never> =>
  storage
    .query(
      `INSERT INTO codegraph_tool_usage (tool_id, session_id, last_used_at, use_count)
       VALUES (?, ?, unixepoch(), 1)
       ON CONFLICT(tool_id) DO UPDATE SET
         last_used_at = unixepoch(),
         use_count = codegraph_tool_usage.use_count + 1`,
      [toolID, sessionID ?? null],
    )
    .pipe(
      Effect.andThen(
        sessionID === undefined
          ? Effect.void
          : storage.query(
              `INSERT INTO tool_usage_session (session_id, tool_id, last_used_at, use_count)
               VALUES (?, ?, unixepoch(), 1)
               ON CONFLICT(session_id, tool_id) DO UPDATE SET
                 last_used_at = unixepoch(),
                 use_count = tool_usage_session.use_count + 1`,
              [sessionID, toolID],
            ),
      ),
      Effect.asVoid,
      Effect.catchCause((cause) => Effect.logWarning("tool usage record failed", { cause: Cause.pretty(cause) })),
    )

export const listToolUsage = (
  storage: Storage.Interface,
  input?: { readonly session?: string },
): Effect.Effect<ToolUsageResult, never, never> => {
  const session = input?.session
  return storage
    .query<{ tool_id: string; use_count: number; last_used_at: number }>(
      session === undefined
        ? `SELECT tool_id, use_count, last_used_at FROM codegraph_tool_usage
           ORDER BY use_count DESC LIMIT 50`
        : `SELECT tool_id, use_count, last_used_at FROM tool_usage_session
           WHERE session_id = ?
           ORDER BY use_count DESC LIMIT 50`,
      session === undefined ? [] : [session],
    )
    .pipe(
      Effect.map((rows) => ({
        tools: rows.map((row) => ({
          toolId: row.tool_id,
          useCount: row.use_count,
          lastUsedAt: row.last_used_at,
        })),
      })),
      Effect.catchCause(() => Effect.succeed({ tools: [] })),
    )
}

export interface GatewayUsageRecord {
  readonly sessionID: string
  readonly from: string
  readonly to?: string
  readonly route: GatewayRouteName
  readonly bytesSaved?: number
}

/** One row per (session, from, to, route); never fails. */
export const recordGatewayUsage = (
  storage: Storage.Interface,
  input: GatewayUsageRecord,
): Effect.Effect<void, never, never> =>
  storage
    .query(
      `INSERT INTO gateway_usage (session_id, from_tool, to_tool, route, last_used_at, use_count, bytes_saved)
       VALUES (?, ?, ?, ?, unixepoch(), 1, ?)
       ON CONFLICT(session_id, from_tool, to_tool, route) DO UPDATE SET
         last_used_at = unixepoch(),
         use_count = gateway_usage.use_count + 1,
         bytes_saved = gateway_usage.bytes_saved + excluded.bytes_saved`,
      [input.sessionID, input.from, input.to ?? "", input.route, Math.max(0, Math.round(input.bytesSaved ?? 0))],
    )
    .pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => Effect.logWarning("gateway usage record failed", { cause: Cause.pretty(cause) })),
    )

const ROUTES = new Set<string>(["swapped", "fallback", "augmented", "direct"])

const asRoute = (value: string): GatewayRouteName =>
  ROUTES.has(value) ? (value as GatewayRouteName) : "direct"

export const listGatewayUsage = (
  storage: Storage.Interface,
  input?: { readonly session?: string },
): Effect.Effect<GatewayUsageResult, never, never> => {
  const session = input?.session
  return storage
    .query<{
      from_tool: string
      to_tool: string
      route: string
      use_count: number
      bytes_saved: number
      last_used_at: number
    }>(
      `SELECT from_tool, to_tool, route, use_count, bytes_saved, last_used_at FROM gateway_usage
       ${session === undefined ? "" : "WHERE session_id = ?"}
       ORDER BY use_count DESC LIMIT 100`,
      session === undefined ? [] : [session],
    )
    .pipe(
      Effect.map((rows) => {
        const summary = { swapped: 0, fallback: 0, augmented: 0, direct: 0, bytesSaved: 0 }
        const result = rows.map((row): GatewayUsageRow => {
          const route = asRoute(row.route)
          summary[route] += row.use_count
          summary.bytesSaved += row.bytes_saved
          return {
            fromTool: row.from_tool,
            toTool: row.to_tool,
            route,
            useCount: row.use_count,
            bytesSaved: row.bytes_saved,
            lastUsedAt: row.last_used_at,
          }
        })
        return { rows: result, summary }
      }),
      Effect.catchCause(() =>
        Effect.succeed({
          rows: [],
          summary: { swapped: 0, fallback: 0, augmented: 0, direct: 0, bytesSaved: 0 },
        }),
      ),
    )
}

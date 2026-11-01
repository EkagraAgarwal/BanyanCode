export * as ToolUsage from "./usage.js"

import { Cause, Effect } from "effect"
import type { Storage } from "../storage/index.js"

// Port of v1 `AdaptedCatalog.recordUsage` + `CodegraphRepo.listToolUsage`
// against the v2 plugin database. `codegraph_tool_usage` is the same
// per-tool aggregate table (tool_id PK, lifetime use_count, last_used_at in
// epoch seconds), so the TUI tool-usage panel keeps its wire shape.

export interface ToolUsageRow {
  readonly toolId: string
  readonly useCount: number
  readonly lastUsedAt: number
}

export interface ToolUsageResult {
  readonly tools: readonly ToolUsageRow[]
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
      Effect.asVoid,
      Effect.catchCause((cause) => Effect.logWarning("tool usage record failed", { cause: Cause.pretty(cause) })),
    )

export const listToolUsage = (
  storage: Storage.Interface,
  input?: { readonly session?: string },
): Effect.Effect<ToolUsageResult, never, never> =>
  storage
    .query<{ tool_id: string; use_count: number; last_used_at: number }>(
      input?.session === undefined
        ? `SELECT tool_id, use_count, last_used_at FROM codegraph_tool_usage
           ORDER BY use_count DESC LIMIT 50`
        : `SELECT tool_id, use_count, last_used_at FROM codegraph_tool_usage
           WHERE session_id = ?
           ORDER BY use_count DESC LIMIT 50`,
      input?.session === undefined ? [] : [input.session],
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

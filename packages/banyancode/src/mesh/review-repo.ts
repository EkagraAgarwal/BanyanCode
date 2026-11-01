import { Effect } from "effect"
import type { Interface as Storage, StorageError } from "../storage/service.js"
import type { ReviewStatus, SubagentReviewRequest } from "./types.js"

interface ReviewRow {
  readonly id: string
  readonly parent_session_id: string
  readonly target_agent: string
  readonly diff: string | null
  readonly description: string | null
  readonly paths: string | null
  readonly priority: string | null
  readonly reason: string | null
  readonly status: string
  readonly created_at: number
  readonly updated_at: number
  readonly result: string | null
}

const decodeJson = <T>(raw: string | null): T | null => {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return raw as unknown as T
  }
}

const encodeJson = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value))

const toRequest = (row: ReviewRow): SubagentReviewRequest => ({
  id: row.id,
  parentSessionID: row.parent_session_id,
  targetAgent: row.target_agent,
  diff: row.diff,
  description: row.description,
  paths: decodeJson<readonly string[]>(row.paths),
  priority: row.priority,
  reason: row.reason,
  status: row.status as ReviewStatus,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
  result: decodeJson<unknown>(row.result),
})

export interface ReviewsRepo {
  readonly put: (request: SubagentReviewRequest) => Effect.Effect<void, StorageError>
  readonly getByID: (id: string) => Effect.Effect<SubagentReviewRequest | undefined, StorageError>
  readonly listByParent: (parentSessionID: string) => Effect.Effect<readonly SubagentReviewRequest[], StorageError>
  readonly listPending: () => Effect.Effect<readonly SubagentReviewRequest[], StorageError>
  /** Conditional pending → dispatched transition. Returns true when this caller won. */
  readonly markDispatched: (id: string) => Effect.Effect<boolean, StorageError>
  readonly markCompleted: (input: { readonly id: string; readonly result: unknown }) => Effect.Effect<void, StorageError>
  readonly markFailed: (input: { readonly id: string; readonly result: unknown }) => Effect.Effect<void, StorageError>
}

export const makeReviewsRepo = (storage: Storage): ReviewsRepo => {
  const put: ReviewsRepo["put"] = (request) =>
    storage
      .query(
        `INSERT INTO subagent_review_requests
           (id, parent_session_id, target_agent, diff, description, paths, priority, reason, status, created_at, updated_at, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           parent_session_id = excluded.parent_session_id,
           target_agent = excluded.target_agent,
           diff = excluded.diff,
           description = excluded.description,
           paths = excluded.paths,
           priority = excluded.priority,
           reason = excluded.reason,
           status = excluded.status,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           result = excluded.result`,
        [
          request.id,
          request.parentSessionID,
          request.targetAgent,
          request.diff,
          request.description,
          encodeJson(request.paths),
          request.priority,
          request.reason,
          request.status,
          request.createdAt,
          request.updatedAt,
          encodeJson(request.result),
        ],
      )
      .pipe(Effect.asVoid)

  const getByID: ReviewsRepo["getByID"] = (id) =>
    storage
      .query<ReviewRow>("SELECT * FROM subagent_review_requests WHERE id = ?", [id])
      .pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : toRequest(rows[0]))))

  const listByParent: ReviewsRepo["listByParent"] = (parentSessionID) =>
    storage
      .query<ReviewRow>(
        "SELECT * FROM subagent_review_requests WHERE parent_session_id = ? ORDER BY created_at ASC",
        [parentSessionID],
      )
      .pipe(Effect.map((rows) => rows.map(toRequest)))

  const listPending: ReviewsRepo["listPending"] = () =>
    storage
      .query<ReviewRow>(
        "SELECT * FROM subagent_review_requests WHERE status = 'pending' ORDER BY created_at ASC",
      )
      .pipe(Effect.map((rows) => rows.map(toRequest)))

  const markDispatched: ReviewsRepo["markDispatched"] = (id) =>
    storage
      .query<{ id: string }>(
        "UPDATE subagent_review_requests SET status = 'dispatched', updated_at = ? WHERE id = ? AND status = 'pending' RETURNING id",
        [Date.now(), id],
      )
      .pipe(Effect.map((rows) => rows.length > 0))

  const markCompleted: ReviewsRepo["markCompleted"] = (input) =>
    storage
      .query("UPDATE subagent_review_requests SET status = 'completed', updated_at = ?, result = ? WHERE id = ?", [
        Date.now(),
        encodeJson(input.result),
        input.id,
      ])
      .pipe(Effect.asVoid)

  const markFailed: ReviewsRepo["markFailed"] = (input) =>
    storage
      .query("UPDATE subagent_review_requests SET status = 'failed', updated_at = ?, result = ? WHERE id = ?", [
        Date.now(),
        encodeJson(input.result),
        input.id,
      ])
      .pipe(Effect.asVoid)

  return { put, getByID, listByParent, listPending, markDispatched, markCompleted, markFailed }
}

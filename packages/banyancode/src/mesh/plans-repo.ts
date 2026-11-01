import { Effect } from "effect"
import type { Interface as Storage, StorageError } from "../storage/service.js"
import { decodePayload, encodePayload } from "./payload.js"
import type { PlanStatus, PlanStep, PlanStepStatus, SubagentPlan } from "./types.js"

interface PlanRow {
  readonly id: string
  readonly parent_session_id: string
  readonly agent: string
  readonly session_id: string
  readonly title: string
  readonly steps: string
  readonly exit_criteria: string
  readonly status: string
  readonly created_at: number
  readonly updated_at: number
}

const toPlan = (row: PlanRow): SubagentPlan => ({
  id: row.id,
  parentSessionID: row.parent_session_id,
  agent: row.agent,
  sessionID: row.session_id,
  title: row.title,
  steps: decodePayload<readonly PlanStep[]>(row.steps),
  exitCriteria: row.exit_criteria,
  status: row.status as PlanStatus,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

export interface PlansRepo {
  readonly put: (plan: SubagentPlan) => Effect.Effect<void, StorageError>
  readonly getByID: (id: string) => Effect.Effect<SubagentPlan | undefined, StorageError>
  readonly listByParent: (parentSessionID: string) => Effect.Effect<readonly SubagentPlan[], StorageError>
  readonly listBySession: (sessionID: string) => Effect.Effect<readonly SubagentPlan[], StorageError>
  readonly markCompleted: (id: string) => Effect.Effect<void, StorageError>
  readonly markCancelled: (id: string) => Effect.Effect<void, StorageError>
  /** Out-of-bounds indices return the plan unchanged; unknown ids return undefined. */
  readonly setStepStatus: (
    planID: string,
    stepIndex: number,
    status: PlanStepStatus,
   ) => Effect.Effect<SubagentPlan | undefined, StorageError>
}

export const makePlansRepo = (storage: Storage): PlansRepo => {
  const put: PlansRepo["put"] = (plan) =>
    storage
      .query(
        `INSERT INTO subagent_plans
           (id, parent_session_id, agent, session_id, title, steps, exit_criteria, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           parent_session_id = excluded.parent_session_id,
           agent = excluded.agent,
           session_id = excluded.session_id,
           title = excluded.title,
           steps = excluded.steps,
           exit_criteria = excluded.exit_criteria,
           status = excluded.status,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
        [
          plan.id,
          plan.parentSessionID,
          plan.agent,
          plan.sessionID,
          plan.title,
          encodePayload(plan.steps),
          plan.exitCriteria,
          plan.status,
          plan.createdAt,
          plan.updatedAt,
        ],
      )
      .pipe(Effect.asVoid)

  const getByID: PlansRepo["getByID"] = (id) =>
    storage
      .query<PlanRow>("SELECT * FROM subagent_plans WHERE id = ?", [id])
      .pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : toPlan(rows[0]))))

  const listByParent: PlansRepo["listByParent"] = (parentSessionID) =>
    storage
      .query<PlanRow>("SELECT * FROM subagent_plans WHERE parent_session_id = ? ORDER BY created_at ASC", [
        parentSessionID,
      ])
      .pipe(Effect.map((rows) => rows.map(toPlan)))

  const listBySession: PlansRepo["listBySession"] = (sessionID) =>
    storage
      .query<PlanRow>("SELECT * FROM subagent_plans WHERE session_id = ? ORDER BY created_at ASC", [sessionID])
      .pipe(Effect.map((rows) => rows.map(toPlan)))

  const markCompleted: PlansRepo["markCompleted"] = (id) =>
    storage
      .query("UPDATE subagent_plans SET status = 'completed', updated_at = ? WHERE id = ?", [Date.now(), id])
      .pipe(Effect.asVoid)

  const markCancelled: PlansRepo["markCancelled"] = (id) =>
    storage
      .query("UPDATE subagent_plans SET status = 'cancelled', updated_at = ? WHERE id = ?", [Date.now(), id])
      .pipe(Effect.asVoid)

  const setStepStatus: PlansRepo["setStepStatus"] = (planID, stepIndex, status) =>
    // Read-modify-write must be atomic: a concurrent writer to the same row
    // would otherwise clobber the other's step update. The storage lock
    // serialises writers across plugin instances sharing this database.
    storage.withWriteLock(
      Effect.gen(function* () {
        const rows = yield* storage.query<PlanRow>("SELECT * FROM subagent_plans WHERE id = ?", [planID])
        const row = rows[0]
        if (row === undefined) return undefined
        const plan = toPlan(row)
        if (stepIndex < 0 || stepIndex >= plan.steps.length) return plan
        const steps = plan.steps.map((step, index) =>
          index === stepIndex ? { content: step.content, status } : step,
        )
        const now = Date.now()
        yield* storage.query("UPDATE subagent_plans SET steps = ?, updated_at = ? WHERE id = ?", [
          encodePayload(steps),
          now,
          planID,
        ])
        return { ...plan, steps, updatedAt: now }
      }),
    ).pipe(Effect.orDie)

  return { put, getByID, listByParent, listBySession, markCompleted, markCancelled, setStepStatus }
}

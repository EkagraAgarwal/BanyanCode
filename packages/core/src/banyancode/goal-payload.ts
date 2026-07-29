/**
 * Goal payload envelope.
 *
 * Goal exit criteria can be persisted as JSONB by downstream goal-loop
 * consumers. Writers SHOULD use `encodeGoalValue(payload)` so the stored shape
 * carries an explicit `_v`; readers MUST use `unwrapGoalValue(raw)`, which
 * accepts both the versioned envelope and legacy bare goal payloads.
 */

import { Schema } from "effect"

export const GoalStatusSchema = Schema.Literals(["active", "achieved", "blocked", "cancelled"])
export type GoalStatus = Schema.Schema.Type<typeof GoalStatusSchema>

export const GoalReviewVerdictSchema = Schema.Literals(["pass", "fail", "blocked"])
export type GoalReviewVerdict = Schema.Schema.Type<typeof GoalReviewVerdictSchema>

export const GoalPayloadV1Schema = Schema.Struct({
  condition: Schema.String,
  planPath: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.Literals(["low", "normal", "high"])),
  iterationCount: Schema.Number,
  lastReviewVerdict: Schema.optional(GoalReviewVerdictSchema),
  lastReviewReason: Schema.optional(Schema.String),
}).annotate({ identifier: "Banyan/GoalPayloadV1" })

export type GoalPayloadV1 = Schema.Schema.Type<typeof GoalPayloadV1Schema>

export const GoalEnvelopeV1Schema = Schema.Struct({
  _v: Schema.Literal(1),
  data: GoalPayloadV1Schema,
}).annotate({ identifier: "Banyan/GoalEnvelopeV1" })

export type GoalEnvelopeV1 = Schema.Schema.Type<typeof GoalEnvelopeV1Schema>

export const CURRENT_ENVELOPE_VERSION = 1

const isEnvelopeShape = (raw: unknown): raw is { _v: unknown; data: unknown } => {
  if (!raw || typeof raw !== "object") return false
  const r = raw as Record<string, unknown>
  return typeof r._v === "number" && "data" in r
}

export const encodeGoalValue = (payload: GoalPayloadV1): GoalEnvelopeV1 => ({
  _v: CURRENT_ENVELOPE_VERSION,
  data: payload,
})

/**
 * Decode any stored `value` into a `GoalPayloadV1`. Accepts:
 *  - the versioned envelope `{ _v: 1, data }` (returns `data`)
 *  - a bare legacy shape with `condition: string` (returns it as-is)
 *  - a synthesized stub if input is unusable
 */
export const unwrapGoalValue = (raw: unknown): GoalPayloadV1 => {
  if (isEnvelopeShape(raw) && raw.data && typeof raw.data === "object") {
    const data = raw.data as Record<string, unknown>
    if (typeof data.condition === "string") return data as unknown as GoalPayloadV1
  }
  if (raw && typeof raw === "object") {
    const data = raw as Record<string, unknown>
    if (typeof data.condition === "string") return data as unknown as GoalPayloadV1
  }
  return {
    condition: "",
    iterationCount: 0,
  }
}

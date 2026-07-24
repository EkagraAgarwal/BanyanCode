/**
 * Subagent types — Phase 0 G1/G2, Phase 1A G3, Phase 1D G4.
 *
 * G1: idempotent retry mechanism via `idempotencyKey` + `createdAt`.
 * G2: versioned JSONB envelope on `subagent_messages.payload` and
 *     `subagent_plans.steps`.
 * G3: `plan_update` message kind + `planID` correlation invariant. A
 *     `plan_update` message MUST carry `planID` matching a row in the
 *     subagent_plans table; the consumer treats absence as "mark delivered"
 *     and the repo treats unknown planID as a no-op (returns undefined).
 * G4: `review` message kind + `reviewID` correlation invariant. A `review`
 *     message MUST carry `reviewID` matching a row in the
 *     `subagent_review_requests` table. The Phase 1D opencode-side review
 *     bridge (`packages/opencode/src/effect/banyancode-review-bridge.ts`)
 *     drains the SubagentBus global queue and dispatches a `reviewer`
 *     subagent session for each message; the bridge persists the result
 *     back to the row keyed by `reviewID`.
 */

import { Schema } from "effect"

// Re-export from types.ts for consumers
export type { SubagentMessage } from "./types"

export type MessageKind = "request" | "inform" | "answer" | "poll" | "steer" | "checkpoint" | "plan" | "plan_update" | "kill" | "review"

/** Branded string for idempotency keys. */
export type IdempotencyKey = string & { readonly _brand: unique symbol }

/** Versioned envelope for stored payloads. */
export const PayloadEnvelopeV1Schema = <T>(dataSchema: Schema.Schema<T>) =>
  Schema.Struct({
    _v: Schema.Literal(1),
    data: dataSchema,
  }).annotate({ identifier: "Banyan/PayloadEnvelopeV1" })

export type PayloadEnvelope<T> = Schema.Schema.Type<ReturnType<typeof PayloadEnvelopeV1Schema>>

export const CURRENT_PAYLOAD_VERSION = 1

/**
 * Wrap a payload in the v1 envelope.
 */
export const wrapPayload = <T>(data: T): { _v: 1; data: T } => ({
  _v: CURRENT_PAYLOAD_VERSION,
  data,
})

/**
 * True when `raw` looks like a versioned envelope ({ _v: number, data: unknown }).
 */
const isEnvelopeShape = (raw: unknown): raw is { _v: unknown; data: unknown } => {
  if (!raw || typeof raw !== "object") return false
  const r = raw as Record<string, unknown>
  return typeof r._v === "number" && "data" in r
}

/**
 * Unwrap a stored payload. Accepts both:
 * - the versioned envelope `{ _v: 1, data }` (returns `data`)
 * - bare unstructured payload (returns it as-is)
 *
 * This is the defensive parse per the memory-payload.ts pattern.
 */
export const unwrapPayload = <T>(raw: unknown): T => {
  if (isEnvelopeShape(raw)) return raw.data as T
  return raw as T
}

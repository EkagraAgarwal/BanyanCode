/**
 * Memory payload envelope — Phase 1a.
 *
 * `memory_entries.value` is JSONB and historically held arbitrary JSON.
 * To make payload shapes durable and forward-compatible, callers SHOULD write
 * `encodeMemoryValue(payload)`; readers MUST use `unwrapMemoryValue(raw)`
 * which accepts both the versioned envelope AND legacy free-form JSON.
 */

import { Schema } from "effect"

export const MemoryKinds = [
  "preference",
  "identity",
  "convention",
  "decision",
  "architecture",
  "pattern",
  "warning",
  "failure",
  "todo",
  "observation",
  "summary",
  "ownership",
  "constraint",
  "environment",
] as const

export const MemoryKindSchema = Schema.Literals(MemoryKinds)
export type MemoryKind = (typeof MemoryKinds)[number]

export const MemoryStatusSchema = Schema.Literals(["pending", "active", "superseded", "rejected", "expired"])
export type MemoryStatus = Schema.Schema.Type<typeof MemoryStatusSchema>

export const MemoryConfidenceSchema = Schema.Literals(["low", "medium", "high"])
export type MemoryConfidence = Schema.Schema.Type<typeof MemoryConfidenceSchema>

export const MemoryImportanceSchema = Schema.Literals(["low", "medium", "high"])
export type MemoryImportance = Schema.Schema.Type<typeof MemoryImportanceSchema>

export const MemorySourceTypeSchema = Schema.Literals(["user", "agent", "system", "import"])
export type MemorySourceType = Schema.Schema.Type<typeof MemorySourceTypeSchema>

export const MemorySourceSchema = Schema.Struct({
  type: MemorySourceTypeSchema,
  ref: Schema.optional(Schema.String),
})
export type MemorySource = Schema.Schema.Type<typeof MemorySourceSchema>

export const MemoryPayloadV1Schema = Schema.Struct({
  kind: MemoryKindSchema,
  title: Schema.String,
  body: Schema.String,
  source: MemorySourceSchema,
  confidence: MemoryConfidenceSchema,
  importance: MemoryImportanceSchema,
  status: MemoryStatusSchema,
  tags: Schema.optional(Schema.Array(Schema.String)),
  fileRefs: Schema.optional(Schema.Array(Schema.String)),
  symbolRefs: Schema.optional(Schema.Array(Schema.String)),
  supersedes: Schema.optional(Schema.String),
  supersededBy: Schema.optional(Schema.String),
  lastReferencedAt: Schema.optional(Schema.Number),
  retrievalCount: Schema.optional(Schema.Number),
}).annotate({ identifier: "Banyan/MemoryPayloadV1" })

export type MemoryPayloadV1 = Schema.Schema.Type<typeof MemoryPayloadV1Schema>

export const MemoryEnvelopeV1Schema = Schema.Struct({
  _v: Schema.Literal(1),
  data: MemoryPayloadV1Schema,
}).annotate({ identifier: "Banyan/MemoryEnvelopeV1" })

export type MemoryEnvelopeV1 = Schema.Schema.Type<typeof MemoryEnvelopeV1Schema>

export const CURRENT_ENVELOPE_VERSION = 1

/** True when `raw` looks like a versioned envelope (has numeric `_v` + `data`). */
const isEnvelopeShape = (raw: unknown): raw is { _v: unknown; data: unknown } => {
  if (!raw || typeof raw !== "object") return false
  const r = raw as Record<string, unknown>
  return typeof r._v === "number" && "data" in r
}

const isPayloadShape = (raw: unknown): raw is MemoryPayloadV1 => {
  if (!raw || typeof raw !== "object") return false
  const r = raw as Record<string, unknown>
  return (
    typeof r.kind === "string" &&
    typeof r.title === "string" &&
    typeof r.body === "string" &&
    typeof r.source === "object" &&
    r.source !== null &&
    typeof (r.source as Record<string, unknown>).type === "string" &&
    typeof r.confidence === "string" &&
    typeof r.importance === "string" &&
    typeof r.status === "string"
  )
}

const synthesizeLegacyPayload = (raw: unknown, fallbackTitle: string): MemoryPayloadV1 => {
  let body: string
  if (typeof raw === "string") body = raw
  else {
    try {
      body = JSON.stringify(raw)
    } catch {
      body = String(raw)
    }
  }
  return {
    kind: "observation",
    title: fallbackTitle || "legacy",
    body,
    source: { type: "system" },
    confidence: "low",
    importance: "low",
    status: "active",
  }
}

/**
 * Returns true when `raw` is already a structured payload (either wrapped or
 * bare). Useful for callers that want to preserve existing payload shape
 * instead of double-wrapping.
 */
export const looksLikeMemoryPayload = (raw: unknown): boolean => {
  if (isEnvelopeShape(raw)) return isPayloadShape(raw.data)
  return isPayloadShape(raw)
}

/**
 * Wrap a payload in the version 1 envelope. The caller is expected to have
 * constructed a `MemoryPayloadV1` (use `synthesizeLegacyPayload` for raw
 * JSON or strings).
 */
export const encodeMemoryValue = (payload: MemoryPayloadV1): MemoryEnvelopeV1 => ({
  _v: CURRENT_ENVELOPE_VERSION,
  data: payload,
})

/**
 * Decode any stored `value` into a `MemoryPayloadV1`. Accepts:
 *  - the versioned envelope `{ _v: 1, data }` (returns `data`)
 *  - a bare structured payload (returns it as-is)
 *  - legacy raw JSON / string / number (synthesizes an observation payload)
 */
export const unwrapMemoryValue = (raw: unknown, fallbackTitle?: string): MemoryPayloadV1 => {
  if (isEnvelopeShape(raw)) {
    if (isPayloadShape(raw.data)) return raw.data
    // Malformed envelope — fall through to synthesize so callers always get a payload.
    return synthesizeLegacyPayload(raw.data, fallbackTitle ?? "legacy")
  }
  if (isPayloadShape(raw)) return raw
  return synthesizeLegacyPayload(raw, fallbackTitle ?? "legacy")
}

/**
 * Normalize a user-supplied payload-or-raw value into a (payload, envelope)
 * pair ready for `MemoryRepo.put`. Returns `{ payload, encoded }`. The
 * `payload` is also returned separately so callers can derive denormalized
 * columns from it.
 */
export const normalizeMemoryValue = (
  raw: unknown,
  fallbackTitle: string,
): { payload: MemoryPayloadV1; encoded: MemoryEnvelopeV1 } => {
  const payload = unwrapMemoryValue(raw, fallbackTitle)
  return { payload, encoded: encodeMemoryValue(payload) }
}

/** A short, plain-text projection of the payload for FTS indexing / display. */
export const payloadBody = (payload: MemoryPayloadV1): string => payload.body

/** Cheap equality guard: do two payloads have the same semantic kind + title? */
export const payloadFingerprint = (payload: MemoryPayloadV1): string =>
  `${payload.kind}::${payload.title.trim().toLowerCase()}`
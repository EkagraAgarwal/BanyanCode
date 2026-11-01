import { createHash } from "node:crypto"

/**
 * Versioned JSON payloads for plugin-owned text columns. The v1 lesson:
 * `text({ mode: "json" })` columns should carry `{ _v: 1, data }`, and reads
 * must accept both the envelope and legacy bare values so old rows keep
 * working after a schema evolution.
 */
export const CURRENT_PAYLOAD_VERSION = 1

export const wrapPayload = <T>(data: T): { _v: 1; data: T } => ({
  _v: CURRENT_PAYLOAD_VERSION,
  data,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isEnvelope = (raw: unknown): raw is { _v: number; data: unknown } =>
  isRecord(raw) && typeof raw._v === "number" && "data" in raw

/** Defensive read: accepts the versioned envelope and legacy bare payloads. */
export const unwrapPayload = <T>(raw: unknown): T => (isEnvelope(raw) ? (raw.data as T) : (raw as T))

export const encodePayload = (payload: unknown): string => JSON.stringify(wrapPayload(payload))

export const decodePayload = <T = unknown>(raw: unknown): T => {
  if (typeof raw !== "string") return unwrapPayload<T>(raw)
  try {
    return unwrapPayload<T>(JSON.parse(raw))
  } catch {
    return raw as T
  }
}

/** Deterministic JSON: object keys sorted at every depth. */
export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`
}

/**
 * Stable fallback idempotency key. Derived from the logical message content so
 * an LLM retry (new tool call id, same payload) upserts the same row. v1 used
 * `Hash.fast`; the plugin cannot import core, so sha256 is the deterministic
 * stand-in (both Bun and Node ship `node:crypto`).
 */
export const idempotencyKeyFor = (input: {
  readonly sessionID: string
  readonly kind: string
  readonly to?: string
  readonly payload: unknown
}): string => {
  const digest = createHash("sha256")
    .update(`${input.kind}|${input.to ?? ""}|${stableStringify(input.payload)}`)
    .digest("hex")
  return `lk_${input.sessionID}_${digest.slice(0, 24)}`
}

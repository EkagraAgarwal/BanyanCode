// Structured MCP tool-result helpers for the read-only code tools.
//
// Two jobs: keep large index dumps inside a char budget without producing
// invalid JSON (structural truncation: shrink arrays / object entries /
// long strings, never slice the serialized text), and give every tool a
// stable result shape — `structuredContent` conforming to a declared
// `outputSchema` plus a short text rendering, and `isError` results with
// stable `code` strings callers can branch on.

import { z } from "zod/v3"
import type { AnyObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js"

// Default budget. Another wave owns the deep config plumbing; until then
// an explicit arg or env overrides the default without touching call sites.
export const DEFAULT_OUTPUT_CHARS = 8000

export const resolveOutputChars = (explicit?: number): number => {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit)
  const env = Number(process.env.BANYANCODE_MCP_OUTPUT_CHARS)
  if (Number.isFinite(env) && env > 0) return Math.floor(env)
  return DEFAULT_OUTPUT_CHARS
}

export const McpErrorCodes = [
  "POLICY_REJECTED",
  "PATH_ESCAPE",
  "UNKNOWN_TASK",
  "NOT_INDEXED",
  "UPSTREAM_ERROR",
  "INVALID_ARGUMENTS",
] as const
export type McpErrorCode = (typeof McpErrorCodes)[number]

export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

// Declared as `outputSchema` on every code tool. `result` stays unconstrained
// (index rows vary per op) while the envelope fields are typed; the SDK
// validates `structuredContent` against this on every non-error result.
const OutputSchemaInput = z.object({
  result: z.unknown().describe("Truncated tool payload (arrays / entries / long strings shrunk to fit the output budget)."),
  truncated: z.boolean().describe("True when the payload was shrunk to fit the output budget."),
  omitted: z.number().int().min(0).describe("Array items plus object entries dropped by truncation."),
})
export const CodeToolOutputSchema = OutputSchemaInput as unknown as AnyObjectSchema

const renderJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? "null"
  } catch {
    return '"[unserializable]"'
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

type ShrinkState = {
  omitted: number
  truncatedStrings: number
}

// Recursively shrink arrays (cap length), plain objects (cap entries), and
// long strings (slice with an inline marker). Circular refs become a marker.
const shrinkValue = (
  value: unknown,
  arrayCap: number,
  keyCap: number,
  stringCap: number,
  state: ShrinkState,
  seen: WeakSet<object>,
): unknown => {
  if (typeof value === "string") {
    if (value.length <= stringCap) return value
    state.truncatedStrings += 1
    return `${value.slice(0, Math.max(0, stringCap))}…[truncated ${value.length - stringCap} chars]`
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      state.truncatedStrings += 1
      return "[circular]"
    }
    seen.add(value)
    const kept = value.length > arrayCap ? value.slice(0, arrayCap) : value
    state.omitted += value.length - kept.length
    const out = kept.map((item) => shrinkValue(item, arrayCap, keyCap, stringCap, state, seen))
    seen.delete(value)
    return out
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) {
      state.truncatedStrings += 1
      return "[circular]"
    }
    seen.add(value)
    const entries = Object.entries(value)
    const kept = entries.length > keyCap ? entries.slice(0, keyCap) : entries
    state.omitted += entries.length - kept.length
    const out: Record<string, unknown> = {}
    for (const [key, entry] of kept) out[key] = shrinkValue(entry, arrayCap, keyCap, stringCap, state, seen)
    seen.delete(value)
    return out
  }
  return value
}

export type TruncatedPayload = {
  data: unknown
  truncated: boolean
  omitted: number
}

// Shrink `value` until its rendered JSON fits `maxChars`. Always returns
// valid JSON-parsable data — the serialized text is never sliced.
export const truncateStructured = (value: unknown, maxChars: number = DEFAULT_OUTPUT_CHARS): TruncatedPayload => {
  if (renderJson(value).length <= maxChars) return { data: value, truncated: false, omitted: 0 }
  let arrayCap = 100
  let keyCap = 100
  let stringCap = 8000
  let data: unknown = value
  let state: ShrinkState = { omitted: 0, truncatedStrings: 0 }
  for (let round = 0; round < 12; round++) {
    state = { omitted: 0, truncatedStrings: 0 }
    data = shrinkValue(value, arrayCap, keyCap, stringCap, state, new WeakSet())
    if (renderJson(data).length <= maxChars) return { data, truncated: true, omitted: state.omitted }
    arrayCap = Math.max(5, Math.floor(arrayCap / 2))
    keyCap = Math.max(5, Math.floor(keyCap / 2))
    stringCap = Math.max(200, Math.floor(stringCap / 2))
  }
  state = { omitted: 0, truncatedStrings: 0 }
  data = shrinkValue(value, 5, 5, 200, state, new WeakSet())
  if (renderJson(data).length <= maxChars) return { data, truncated: true, omitted: state.omitted }
  return {
    data: {
      truncated: true,
      omitted: state.omitted,
      preview: renderJson(data).slice(0, Math.max(0, maxChars)),
    },
    truncated: true,
    omitted: state.omitted,
  }
}

// Success result: short text rendering plus machine-readable structuredContent.
export const okResult = (data: unknown, maxChars?: number): McpToolResult => {
  const cap = resolveOutputChars(maxChars)
  const payload = truncateStructured(data, cap)
  return {
    content: [{ type: "text", text: renderJson(payload.data) }],
    structuredContent: { result: payload.data, truncated: payload.truncated, omitted: payload.omitted },
  }
}

// Error result with a stable code. Always `isError: true` so callers branch
// on `code` instead of parsing prose.
export const errorResult = (code: McpErrorCode, message: string): McpToolResult => ({
  content: [{ type: "text", text: `${code}: ${message}` }],
  isError: true,
})

// Argument-validation failures (bad enum, bad shape, missing per-op arg)
// are tool execution errors the model can self-correct, never protocol
// errors. The SDK already converts inputSchema parse failures to
// `isError` results (SEP-1303); this covers the in-handler checks.
export const invalidArguments = (message: string): McpToolResult => errorResult("INVALID_ARGUMENTS", message)

export * as McpOutput from "./output"

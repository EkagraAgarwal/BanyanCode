export * as McpVerifyMemory from "./tools-verify-memory"

import { Schema } from "effect"

export const VerifyKinds = ["typecheck", "test", "lint"] as const
export type VerifyKind = (typeof VerifyKinds)[number]
export const VerifyKindSchema = Schema.Literals(VerifyKinds)

// NOTE: intentionally no `.annotate({ identifier })` on the structs below.
// Identifier-annotated structs used as HTTP bodies corrupt single-element
// array decoding through the HttpApi $ref path (see AGENTS.md). Keep MCP
// schemas inline so `tags: ["one"]` survives the real HTTP layer.
const VERIFY_PATH_PATTERN = /^[a-zA-Z0-9._/*?-][a-zA-Z0-9._/*?-]*$/

export const VerifyInputSchema = Schema.Struct({
  kind: VerifyKindSchema,
  path: Schema.optional(
    Schema.String.check(Schema.isPattern(VERIFY_PATH_PATTERN), Schema.isMinLength(1), Schema.isMaxLength(512)),
  ),
})

export type VerifyInput = Schema.Schema.Type<typeof VerifyInputSchema>

export interface VerifyRawResult {
  readonly status: "passed" | "failed" | "errored"
  readonly summary: Record<string, unknown>
  readonly durationMs: number
  readonly cacheHit: boolean
  readonly rawOutput?: string
}

export interface VerifySummary {
  readonly kind: VerifyKind
  readonly status: "passed" | "failed" | "errored"
  readonly passed: number
  readonly failed: number
  readonly skipped: number
  readonly failures: ReadonlyArray<string>
  readonly durationMs: number
  readonly cacheHit: boolean
}

export const DEFAULT_MAX_FAILURES = 10

const toCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0

const firstFailures = (rawOutput: string | undefined, max: number): ReadonlyArray<string> => {
  if (!rawOutput || max <= 0) return []
  return rawOutput
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, max)
}

export const summarizeVerifyResult = (
  kind: VerifyKind,
  result: VerifyRawResult,
  maxFailures: number = DEFAULT_MAX_FAILURES,
): VerifySummary => ({
  kind,
  status: result.status,
  passed: toCount(result.summary.passed),
  failed: toCount(result.summary.failed),
  skipped: toCount(result.summary.skipped),
  failures: firstFailures(result.rawOutput, maxFailures),
  durationMs: result.durationMs,
  cacheHit: result.cacheHit,
})

export const resolveVerifyRoute = (kind: VerifyKind): string => {
  if (kind === "typecheck") return "/global/typecheck"
  if (kind === "test") return "/global/test-run"
  return "/global/lint"
}

// Memory: only the read + store hand-off ops are MCP-visible. `forget`,
// `promote`, `reject` (and `candidates`/`list` curation) stay TUI-only.
export const McpMemoryOps = ["recall", "search", "store", "get", "summary"] as const
export type McpMemoryOp = (typeof McpMemoryOps)[number]

export const isMcpMemoryOp = (op: string): op is McpMemoryOp =>
  (McpMemoryOps as ReadonlyArray<string>).includes(op)

export const resolveMemoryRoute = (op: McpMemoryOp): string => `/global/memory/${op}`

export const MEMORY_VALUE_MAX_BYTES = 32_768
export const MEMORY_TAGS_MAX = 16
export const MEMORY_TAG_MAX_CHARS = 64
export const MEMORY_ORIGIN = "mcp" as const

// Single-element-array-safe (no identifier): exercised through the real HTTP
// layer in verify-isolation.test.ts.
export const MemoryTagsSchema = Schema.optional(
  Schema.Array(Schema.String.check(Schema.isMaxLength(MEMORY_TAG_MAX_CHARS))),
)

export interface MemoryStoreRequest {
  readonly key: string
  readonly value: unknown
  readonly scope: string
  readonly tags?: ReadonlyArray<string>
}

export const checkMemoryStoreLimits = (input: {
  readonly value: unknown
  readonly tags?: ReadonlyArray<string>
}): string | undefined => {
  const bytes = Buffer.byteLength(JSON.stringify(input.value ?? null), "utf8")
  if (bytes > MEMORY_VALUE_MAX_BYTES) {
    return `memory store value is ${bytes} bytes, limit is ${MEMORY_VALUE_MAX_BYTES}`
  }
  const tags = input.tags ?? []
  if (tags.length > MEMORY_TAGS_MAX) {
    return `memory store has ${tags.length} tags, limit is ${MEMORY_TAGS_MAX}`
  }
  for (const tag of tags) {
    if (tag.length > MEMORY_TAG_MAX_CHARS) {
      return `memory store tag exceeds ${MEMORY_TAG_MAX_CHARS} chars`
    }
  }
  return undefined
}

export const tagMemoryStore = <T extends MemoryStoreRequest>(input: T): T & { readonly origin: typeof MEMORY_ORIGIN } => ({
  ...input,
  tags: [...(input.tags ?? []), `origin:${MEMORY_ORIGIN}`],
  origin: MEMORY_ORIGIN,
})

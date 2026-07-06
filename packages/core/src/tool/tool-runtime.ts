/**
 * Tool Runtime — Phase 3.
 *
 * Deterministic, semantics-preserving transformations applied between the
 * LLM call and `Tool.execute`. Reads the `ToolContract` and applies only
 * the transformations the contract allows. Lives between the LLM call
 * (call.input) and `config.execute(decoded, context)` in `Tool.settle`.
 *
 * Hard guardrails (per Phase 3 plan):
 * - Only deterministic transformations. No semantic decisions.
 * - Alias resolution is one-way only: alias -> canonical. NEVER reverse.
 *   No two-step alias chains. No alias -> alias -> canonical.
 * - Defaults NEVER change query meaning. Only `limit`, `depth`, `region`,
 *   `time`, `numResults`, `offset`, and fields ending in `Limit`/`Count`/
 *   `Depth` get defaults. NEVER `query`, `symbol`, `path`, `function`,
 *   `name`, `target`, `targetSymbol`, `phase`, `kind`, `intent`, or any
 *   field that semantically identifies a search target.
 * - ONE repair pass maximum. No nested retries.
 * - Linter EMITS warnings but NEVER BLOCKS execution.
 *
 * Context Resolver (filling missing `nodeID` from previous tool results)
 * is intentionally NOT here — that's Planner / Phase 4.
 */

import { Effect, Schema } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import type { ToolContract } from "./tool"

export type Normalized = unknown
export type Repaired = unknown
export type RuntimeContext = {
  readonly sessionID: string
  readonly agent: string
  readonly assistantMessageID: string
  readonly toolCallID: string
}

export type RepairKind =
  | "null-removal"
  | "string-trim"
  | "array-stripped"
  | "array-collapse"
  | "lowercase"
  | "coerce-number"
  | "coerce-boolean"
  | "clamp-range"
  | "fallback-string"
  | "fallback-number"

export type RepairRecord = {
  readonly kind: RepairKind
  readonly field: string
  readonly fromValue: unknown
  readonly toValue: unknown
  readonly confidence: number
}

export type LintKind =
  | "alias"
  | "null-removal"
  | "default-fill"
  | "type-coerce"
  | "missing-required"
  | "low-confidence"

export type LintRecord = {
  readonly kind: LintKind
  readonly field: string
  readonly fromValue: unknown
  readonly toValue?: unknown
  readonly confidence: number
  readonly autoFixAvailable: boolean
  readonly suggestedFix?: string
}

export type DecodeError = {
  readonly field: string
  readonly expected: string
  readonly got: unknown
  readonly message: string
}

export type RuntimeResult<A> = {
  readonly input: A | undefined
  readonly normalized: unknown
  readonly repairs: readonly string[]
  readonly warnings: readonly LintRecord[]
  readonly error?: string
}

export interface ToolRuntime {
  readonly contract: ToolContract
  readonly runOnce: <S extends Schema.Top>(raw: unknown, schema: S) => RuntimeResult<S["Type"]>
}

const SEARCH_TERM_BLOCKLIST: ReadonlySet<string> = new Set([
  "query",
  "symbol",
  "path",
  "function",
  "name",
  "target",
  "targetSymbol",
  "phase",
  "kind",
  "intent",
  "interfaceName",
  "methodName",
  "filePath",
  "changeKind",
  "diff",
  "root",
  "workspace",
  "modes",
  "userQuery",
  "topic",
  "term",
])

const NUMERIC_FIELDS_FOR_CLAMP: ReadonlySet<string> = new Set([
  "limit",
  "count",
  "depth",
  "maxDepth",
  "minDepth",
  "offset",
  "numResults",
  "minScore",
])

const ENUM_LIKE_FIELDS: ReadonlySet<string> = new Set([
  "intent",
  "phase",
  "region",
  "time",
  "kind",
  "mode",
  "modes",
  "action",
  "type",
  "changeKind",
  "step",
])

const COLLAPSIBLE_FIELDS: ReadonlySet<string> = new Set([
  "target",
  "function",
  "query",
  "symbol",
  "path",
  "name",
  "intent",
  "phase",
  "kind",
  "interfaceName",
  "methodName",
])

const SAFE_DEFAULT_FIELDS: ReadonlySet<string> = new Set([
  "limit",
  "depth",
  "maxDepth",
  "minDepth",
  "region",
  "time",
  "includeKeywordFallback",
  "numResults",
  "offset",
  "minScore",
  "count",
])

const NUMERIC_FIELD_SUFFIXES = ["Limit", "Count", "Depth"] as const

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const coerceStringToNumber = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v !== "string") return undefined
  const trimmed = v.trim()
  if (trimmed === "") return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

const coerceBoolean = (v: unknown): boolean | undefined => {
  if (typeof v === "boolean") return v
  if (typeof v !== "string") return undefined
  const s = v.trim().toLowerCase()
  if (s === "true" || s === "yes" || s === "1") return true
  if (s === "false" || s === "no" || s === "0") return false
  return undefined
}

const isDefaultableField = (field: string): boolean => {
  if (SEARCH_TERM_BLOCKLIST.has(field)) return false
  if (SAFE_DEFAULT_FIELDS.has(field)) return true
  for (const suffix of NUMERIC_FIELD_SUFFIXES) {
    if (field.length > suffix.length && field.endsWith(suffix)) return true
  }
  return false
}

const describeRepair = (r: RepairRecord): string =>
  `${r.kind} on field '${r.field}' (confidence ${r.confidence})`

const extractErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message
  if (typeof err === "object" && err && "message" in err) return String((err as { message: unknown }).message)
  return String(err)
}

const collectLeafIssues = (
  issue: unknown,
  path: ReadonlyArray<PropertyKey>,
  sink: DecodeError[],
): void => {
  if (!issue || typeof issue !== "object") return
  const anyIssue = issue as {
    _tag?: string
    path?: ReadonlyArray<PropertyKey>
    message?: string
    expected?: unknown
    actual?: unknown
    issues?: ReadonlyArray<unknown>
  }
  if (Array.isArray(anyIssue.issues) && anyIssue.issues.length > 0) {
    for (const inner of anyIssue.issues) {
      const innerPath =
        inner && typeof inner === "object" && "path" in inner && Array.isArray((inner as { path?: unknown }).path)
          ? [...path, ...((inner as { path: ReadonlyArray<PropertyKey> }).path ?? [])]
          : path
      collectLeafIssues(inner, innerPath, sink)
    }
    return
  }
  const fieldPath = path
    .map((seg) => (typeof seg === "number" ? `[${seg}]` : `.${String(seg)}`))
    .join("")
    .replace(/^\./, "")
  sink.push({
    field: fieldPath || "<root>",
    expected:
      typeof anyIssue.expected === "string"
        ? anyIssue.expected
        : typeof anyIssue.message === "string"
          ? anyIssue.message
          : "unknown",
    got: anyIssue.actual,
    message: typeof anyIssue.message === "string" ? anyIssue.message : "decode failed",
  })
}

const extractDecodeErrors = (err: unknown): DecodeError[] => {
  const out: DecodeError[] = []
  if (err && typeof err === "object" && "issue" in err) {
    collectLeafIssues((err as { issue: unknown }).issue, [], out)
  } else {
    collectLeafIssues(err, [], out)
  }
  if (out.length === 0) {
    out.push({
      field: "<root>",
      expected: extractErrorMessage(err),
      got: undefined,
      message: extractErrorMessage(err),
    })
  }
  return out
}

const extractRequiredFields = (schema: Schema.Top | undefined): ReadonlySet<string> => {
  if (!schema) return new Set()
  try {
    const document = Schema.toJsonSchemaDocument(schema)
    const required = document.schema?.required
    if (!Array.isArray(required)) return new Set()
    return new Set(required.filter((r): r is string => typeof r === "string"))
  } catch {
    return new Set()
  }
}

const isArrayField = (s: any): boolean => {
  const checkAST = (ast: any): boolean => {
    if (!ast) return false
    if (ast._tag === "Tuple" || ast._tag === "Arrays") return true
    if (ast._tag === "Union") {
      return ast.types.some(checkAST)
    }
    if (ast._tag === "Transformation") {
      return checkAST(ast.from) || checkAST(ast.to)
    }
    if (ast.ast) return checkAST(ast.ast)
    return false
  }
  return checkAST(s?.ast ?? s)
}

const normalizeValue = (
  value: unknown,
  field: string | undefined,
  repairs: RepairRecord[],
  schema?: Schema.Top,
): unknown => {
  if (value === null) {
    if (field) {
      repairs.push({
        kind: "null-removal",
        field,
        fromValue: null,
        toValue: undefined,
        confidence: 0.9,
      })
    }
    return undefined
  }
  if (Array.isArray(value)) {
    const arr = value
      .map((item) => normalizeValue(item, undefined, repairs))
      .filter((v): v is Exclude<typeof v, undefined> => v !== undefined)
    if (arr.length === 0 && field) {
      repairs.push({
        kind: "array-stripped",
        field,
        fromValue: value,
        toValue: undefined,
        confidence: 0.8,
      })
      return undefined
    }
    if (arr.length === 1 && field) {
      if (schema && isArrayField(schema)) {
        return arr
      }
      repairs.push({
        kind: "array-collapse",
        field,
        fromValue: value,
        toValue: arr[0],
        confidence: 0.7,
      })
      return arr[0]
    }
    return arr
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const fieldSchema = schema && "fields" in schema ? (schema.fields as any)[k] : undefined
      const normalized = normalizeValue(v, k, repairs, fieldSchema)
      if (normalized !== undefined) out[k] = normalized
    }
    return out
  }
  if (typeof value === "string" && field) {
    const trimmed = value.trim()
    if (trimmed !== value) {
      repairs.push({
        kind: "string-trim",
        field,
        fromValue: value,
        toValue: trimmed,
        confidence: 0.95,
      })
    }
    let lowercased: string | undefined
    if (ENUM_LIKE_FIELDS.has(field) && trimmed !== trimmed.toLowerCase()) {
      lowercased = trimmed.toLowerCase()
      repairs.push({
        kind: "lowercase",
        field,
        fromValue: trimmed,
        toValue: lowercased,
        confidence: 0.85,
      })
    }
    const candidate = lowercased ?? trimmed
    const numeric = coerceStringToNumber(candidate)
    if (numeric !== undefined && SAFE_DEFAULT_FIELDS.has(field)) {
      repairs.push({
        kind: "coerce-number",
        field,
        fromValue: candidate,
        toValue: numeric,
        confidence: 0.9,
      })
      return numeric
    }
    const bool = coerceBoolean(candidate)
    if (
      bool !== undefined &&
      (field === "includeKeywordFallback" ||
        field.endsWith("Enabled") ||
        field.startsWith("is") ||
        field.startsWith("has"))
    ) {
      repairs.push({
        kind: "coerce-boolean",
        field,
        fromValue: candidate,
        toValue: bool,
        confidence: 0.85,
      })
      return bool
    }
    return candidate
  }
  return value
}

export const normalize = (raw: unknown, schema?: Schema.Top): readonly [Normalized, readonly RepairRecord[]] => {
  const repairs: RepairRecord[] = []
  const value = normalizeValue(raw, undefined, repairs, schema)
  return [value, repairs] as const
}

export const resolveAliases = (
  input: unknown,
  aliases: Record<string, readonly string[]> | undefined,
): readonly [Normalized, readonly LintRecord[]] => {
  const warnings: LintRecord[] = []
  if (!isPlainObject(input) || !aliases || Object.keys(aliases).length === 0) {
    return [input, warnings] as const
  }
  // Snapshot the input. Alias resolution is one-way: alias -> canonical.
  // We read from the snapshot so that one canonical filling alias2 cannot
  // make alias2 look present to another canonical filling functionName.
  // No two-step chains. Canonical -> alias also never happens.
  const source: Record<string, unknown> = { ...input }
  const out: Record<string, unknown> = { ...input }
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    const canonicalPresent = canonical in source && source[canonical] !== undefined
    let aliasValue: { name: string; value: unknown } | undefined
    for (const alias of aliasList) {
      if (alias in source && source[alias] !== undefined) {
        if (!aliasValue) aliasValue = { name: alias, value: source[alias] }
      }
    }
    if (!canonicalPresent && aliasValue) {
      out[canonical] = aliasValue.value
      for (const alias of aliasList) {
        if (alias in out) delete out[alias]
      }
      warnings.push({
        kind: "alias",
        field: canonical,
        fromValue: aliasValue.value,
        toValue: aliasValue.value,
        confidence: 0.99,
        autoFixAvailable: true,
        suggestedFix: `mapped alias '${aliasValue.name}' to canonical '${canonical}'`,
      })
    } else if (canonicalPresent && aliasValue) {
      for (const alias of aliasList) {
        if (alias in out) delete out[alias]
      }
      warnings.push({
        kind: "alias",
        field: canonical,
        fromValue: aliasValue.value,
        toValue: source[canonical],
        confidence: 0.99,
        autoFixAvailable: true,
        suggestedFix: `dropped alias '${aliasValue.name}' because canonical '${canonical}' was already present`,
      })
    }
  }
  return [out, warnings] as const
}

export const applyDefaults = (
  input: unknown,
  defaults: Record<string, unknown> | undefined,
): readonly [Normalized, readonly LintRecord[]] => {
  const warnings: LintRecord[] = []
  if (!isPlainObject(input) || !defaults || Object.keys(defaults).length === 0) {
    return [input, warnings] as const
  }
  const out: Record<string, unknown> = { ...input }
  for (const [field, value] of Object.entries(defaults)) {
    if (!isDefaultableField(field)) continue
    const present = field in out && out[field] !== undefined
    if (!present) {
      out[field] = value
      warnings.push({
        kind: "default-fill",
        field,
        fromValue: undefined,
        toValue: value,
        confidence: 0.7,
        autoFixAvailable: true,
        suggestedFix: `filled '${field}' with contract default`,
      })
    }
  }
  return [out, warnings] as const
}

export const lint = (
  input: unknown,
  schema: Schema.Top | undefined,
  _aliases?: Record<string, readonly string[]>,
  _defaults?: Record<string, unknown>,
): readonly LintRecord[] => {
  const warnings: LintRecord[] = []
  if (!schema) return warnings
  const required = extractRequiredFields(schema)
  if (required.size === 0) return warnings
  const obj = isPlainObject(input) ? input : {}
  for (const field of required) {
    if (!(field in obj) || obj[field] === undefined) {
      warnings.push({
        kind: "missing-required",
        field,
        fromValue: undefined,
        toValue: undefined,
        confidence: 0.21,
        autoFixAvailable: false,
        suggestedFix: `provide a value for \`${field}\``,
      })
    }
  }
  return warnings
}

const repairValue = (
  input: unknown,
  _errors: readonly DecodeError[],
): {
  readonly value: Repaired
  readonly repairs: readonly RepairRecord[]
  readonly warnings: readonly LintRecord[]
} => {
  const repairs: RepairRecord[] = []
  const warnings: LintRecord[] = []
  if (!isPlainObject(input)) return { value: input, repairs, warnings }
  const out: Record<string, unknown> = { ...input }
  for (const [field, value] of Object.entries(input)) {
    if (typeof value === "number" && NUMERIC_FIELDS_FOR_CLAMP.has(field) && value < 0) {
      const clamped = 0
      out[field] = clamped
      repairs.push({
        kind: "clamp-range",
        field,
        fromValue: value,
        toValue: clamped,
        confidence: 0.7,
      })
      warnings.push({
        kind: "type-coerce",
        field,
        fromValue: value,
        toValue: clamped,
        confidence: 0.7,
        autoFixAvailable: true,
        suggestedFix: `clamped negative value to 0 for '${field}'`,
      })
      continue
    }
    if (typeof value === "number" && (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER)) {
      const clamped = value > 0 ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER
      out[field] = clamped
      repairs.push({
        kind: "clamp-range",
        field,
        fromValue: value,
        toValue: clamped,
        confidence: 0.6,
      })
      warnings.push({
        kind: "type-coerce",
        field,
        fromValue: value,
        toValue: clamped,
        confidence: 0.6,
        autoFixAvailable: true,
        suggestedFix: `clamped value to safe integer range for '${field}'`,
      })
    }
  }
  return { value: out, repairs, warnings }
}

const tryDecodeSync = <T>(
  schema: Schema.Top,
  input: unknown,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } => {
  try {
    const value = (Schema.decodeUnknownSync as (s: Schema.Top) => (i: unknown) => unknown)(
      schema,
    )(input) as T
    return { ok: true, value }
  } catch (err) {
    return { ok: false, error: err }
  }
}

export const repair = <S extends Schema.Top>(
  schema: S,
  rawInput: unknown,
  _ctx: RuntimeContext,
): Effect.Effect<
  {
    readonly ok: true
    readonly value: S["Type"]
    readonly repairs: readonly string[]
    readonly warnings: readonly LintRecord[]
  },
  ToolFailure,
  never
> => {
  const decode = <T>(input: unknown) => tryDecodeSync<T>(schema, input)
  return Effect.gen(function* () {
    const first = decode<S["Type"]>(rawInput)
    if (first.ok) {
      return {
        ok: true as const,
        value: first.value,
        repairs: [] as readonly string[],
        warnings: [] as readonly LintRecord[],
      }
    }
    const errors = extractDecodeErrors(first.error)
    const repaired = repairValue(rawInput, errors)
    const second = decode<S["Type"]>(repaired.value)
    if (second.ok) {
      return {
        ok: true as const,
        value: second.value,
        repairs: repaired.repairs.map(describeRepair),
        warnings: repaired.warnings,
      }
    }
    return yield* Effect.fail(
      new ToolFailure({
        message: `Invalid tool input: ${extractErrorMessage(second.error)}`,
      }),
    )
  })
}

export const runOnce = <S extends Schema.Top>(
  raw: unknown,
  contract: ToolContract,
  schema: S,
): RuntimeResult<S["Type"]> => {
  const [normalized, normRepairs] = normalize(raw, schema)
  const [aliased, aliasWarnings] = resolveAliases(normalized, contract.acceptsAliases)
  const [withDefaults, defaultWarnings] = applyDefaults(aliased, contract.defaultValues)
  const lintWarnings = lint(withDefaults, schema, contract.acceptsAliases, contract.defaultValues)
  const warnings: LintRecord[] = [...aliasWarnings, ...defaultWarnings, ...lintWarnings]
  const internalRepairs: RepairRecord[] = [...normRepairs]

  const first = tryDecodeSync<S["Type"]>(schema, withDefaults)
  if (first.ok) {
    return {
      input: first.value,
      normalized: withDefaults,
      repairs: internalRepairs.map(describeRepair),
      warnings,
    }
  }

  const policy = contract.repairPolicy ?? "one-pass"
  if (policy === "never") {
    return {
      input: undefined,
      normalized: withDefaults,
      repairs: internalRepairs.map(describeRepair),
      warnings,
      error: `Invalid tool input: ${extractErrorMessage(first.error)}`,
    }
  }

  const errors = extractDecodeErrors(first.error)
  const repaired = repairValue(withDefaults, errors)
  const allRepairs: RepairRecord[] = [...internalRepairs, ...repaired.repairs]
  const allWarnings: LintRecord[] = [...warnings, ...repaired.warnings]

  const second = tryDecodeSync<S["Type"]>(schema, repaired.value)
  if (second.ok) {
    return {
      input: second.value,
      normalized: repaired.value,
      repairs: allRepairs.map(describeRepair),
      warnings: allWarnings,
    }
  }

  return {
    input: undefined,
    normalized: repaired.value,
    repairs: allRepairs.map(describeRepair),
    warnings: allWarnings,
    error: `Invalid tool input: ${extractErrorMessage(second.error)}`,
  }
}

export const toolRuntimeForConfig = (config: ToolContract | undefined): ToolRuntime => {
  const contract = config ?? {}
  return {
    contract,
    runOnce: <S extends Schema.Top>(raw: unknown, schema: S) => runOnce(raw, contract, schema),
  }
}

export const ToolRuntime = {
  normalize,
  resolveAliases,
  applyDefaults,
  lint,
  repair,
  runOnce,
  forConfig: toolRuntimeForConfig,
}
import { Schema } from "effect"

/**
 * Verification payloads. Tool inputs/outputs keep the v1 shapes
 * (`packages/core/src/tool/{test,typecheck,lint}.ts`) so agents see identical
 * parameters; the RPC results mirror the v1 `/global/*` handlers.
 */

export const VerificationKind = Schema.Literals(["typecheck", "test", "lint", "compile"])
export type VerificationKind = typeof VerificationKind.Type

export const VerificationStatus = Schema.Literals(["passed", "failed", "errored"])
export type VerificationStatus = typeof VerificationStatus.Type

export const VerificationSummary = Schema.Record(Schema.String, Schema.Unknown)
export type VerificationSummary = typeof VerificationSummary.Type

export const Framework = Schema.Literals(["bun", "jest", "vitest", "mocha"])
export type Framework = typeof Framework.Type

// File-path pattern (typecheck/lint): letters, digits, '.', '_', '-', '/'.
// Rejects `..`, `~`, control characters. Final defense is the resolved-path
// containment check in the service.
const FILE_PATH_PATTERN = /^[a-zA-Z0-9._/-]+$/
// Test paths additionally allow `*` and `?` for globs.
const TEST_PATH_PATTERN = /^[a-zA-Z0-9._*?-][a-zA-Z0-9._/*?-]*$/

const ProjectRoot = Schema.optional(Schema.String.check(Schema.isMaxLength(512))).annotate({
  description: "Project root. Defaults to the current working directory when omitted.",
})

const TimeoutMs = Schema.optional(Schema.Number).annotate({
  description: "Override the default timeout in milliseconds.",
})

const Limit = Schema.optional(Schema.Number).annotate({
  description: "Cap the size of the returned `rawOutput` (in bytes). Defaults to 65536 (64 KB). 0 = no output.",
})

export const TypecheckInput = Schema.Struct({
  path: Schema.optional(
    Schema.String.check(Schema.isPattern(FILE_PATH_PATTERN), Schema.isMaxLength(512)),
  ).annotate({
    description:
      "Optional file path relative to the project root to typecheck. Omit to typecheck the whole project. " +
      "The resolved absolute path MUST stay inside the project root; paths that escape are rejected.",
  }),
  projectRoot: ProjectRoot,
  timeoutMs: TimeoutMs.annotate({
    description:
      "Override the default 5-minute timeout in milliseconds. Useful for fast-feedback loops on small projects.",
  }),
  limit: Limit,
})

export type TypecheckInput = typeof TypecheckInput.Type

export const TestInput = Schema.Struct({
  path: Schema.String.check(
    Schema.isPattern(TEST_PATH_PATTERN),
    Schema.isMinLength(1),
    Schema.isMaxLength(512),
  ).annotate({
    description:
      "REQUIRED. Path to a test file or glob (e.g. 'src/foo.test.ts') relative to the project root. " +
      "The resolved absolute path MUST stay inside the project root; paths that escape are rejected.",
  }),
  framework: Schema.optional(Framework).annotate({
    description: "Test framework to invoke. Defaults to 'bun' (uses `bun test <path>`).",
  }),
  projectRoot: ProjectRoot,
  timeoutMs: TimeoutMs.annotate({
    description: "Override the default 5-minute timeout in milliseconds.",
  }),
  limit: Limit,
})

export type TestInput = typeof TestInput.Type

export const LintInput = Schema.Struct({
  path: Schema.optional(
    Schema.String.check(Schema.isPattern(FILE_PATH_PATTERN), Schema.isMaxLength(512)),
  ).annotate({
    description:
      "Optional file or directory path relative to the project root to lint. Omit to lint the whole project. " +
      "The resolved absolute path MUST stay inside the project root; paths that escape are rejected.",
  }),
  projectRoot: ProjectRoot,
  timeoutMs: TimeoutMs.annotate({
    description: "Override the default 2-minute timeout in milliseconds.",
  }),
  limit: Limit,
})

export type LintInput = typeof LintInput.Type

export const CompileInput = Schema.Struct({
  path: Schema.String.check(Schema.isPattern(FILE_PATH_PATTERN), Schema.isMinLength(1), Schema.isMaxLength(512)),
  projectRoot: ProjectRoot,
  timeoutMs: TimeoutMs,
})

export type CompileInput = typeof CompileInput.Type

const ResultFields = {
  status: VerificationStatus,
  summary: VerificationSummary,
  durationMs: Schema.Number,
  cacheHit: Schema.Boolean,
  rawOutput: Schema.optional(Schema.String),
}

export const TypecheckOutput = Schema.Struct(ResultFields)
export type TypecheckOutput = typeof TypecheckOutput.Type

export const TestOutput = Schema.Struct(ResultFields)
export type TestOutput = typeof TestOutput.Type

export const LintOutput = Schema.Struct({ ...ResultFields, command: Schema.String })
export type LintOutput = typeof LintOutput.Type

export const CompileOutput = Schema.Struct({ ...ResultFields, command: Schema.String })
export type CompileOutput = typeof CompileOutput.Type

/** RPC-only aggregate (same shape as `LintOutput`, `command` optional). */
export const VerifyResult = Schema.Struct({ ...ResultFields, command: Schema.optional(Schema.String) })
export type VerifyResult = typeof VerifyResult.Type

export interface VerifierResult {
  readonly kind: VerificationKind
  readonly target: string
  readonly status: VerificationStatus
  readonly summary: VerificationSummary
  readonly durationMs: number
  readonly cacheHit: boolean
  readonly rawOutput: string | undefined
  readonly command: string
}

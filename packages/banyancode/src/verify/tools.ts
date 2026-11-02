import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import path from "node:path"
import { withinProject, type Interface as VerifierInterface } from "./service.js"
import {
  CompileInput,
  CompileOutput,
  LintInput,
  LintOutput,
  TestInput,
  TestOutput,
  TypecheckInput,
  TypecheckOutput,
  type VerifierResult,
} from "./types.js"

/**
 * v1 tool IDs, kept verbatim. `banyan_typecheck` and `banyan_lint` were
 * declared-but-never-registered in v1 (parity 1c / workstream 3h); they are
 * registered here for the first time.
 */

export const NAME_TEST = "banyan_test"
export const NAME_TYPECHECK = "banyan_typecheck"
export const NAME_LINT = "banyan_lint"
export const NAME_COMPILE = "banyan_compile"

const DEFAULT_OUTPUT_LIMIT = 65_536

/** The location's project root, never the server process cwd. */
const projectRootOf = (ctx: Context): string => ctx.location.project.canonical || ctx.location.project.directory

const clampOutput = (raw: string | undefined, limit: number | undefined): string | undefined => {
  const cap = limit ?? DEFAULT_OUTPUT_LIMIT
  if (cap === 0) return undefined
  const value = raw ?? ""
  return value.length <= cap ? value : value.slice(0, cap)
}

const resultFields = (result: VerifierResult, limit: number | undefined) => {
  const rawOutput = clampOutput(result.rawOutput, limit)
  return {
    status: result.status,
    summary: result.summary,
    durationMs: result.durationMs,
    cacheHit: result.cacheHit,
    ...(rawOutput !== undefined ? { rawOutput } : {}),
  }
}

export const makeTestTool = (ctx: Context, verifier: VerifierInterface): Tool.Info<typeof TestInput, typeof TestOutput> => ({
  name: NAME_TEST,
  description:
    "Verify the project. Use when:\n" +
    "  the agent has finished editing and needs to confirm the project's tests still pass.\n" +
    "Examples\n" +
    '  - "Run my failing test"\n' +
    '  - "Did the rename break the test suite?"\n' +
    "Returns\n" +
    '  { status, summary: {passed, failed, skipped}, durationMs, cacheHit, rawOutput? }\n' +
    "Avoid when\n" +
    "  you only need a single test name — `bun test` already supports `-t <name>` via the shell tool.\n" +
    "After this, often: typecheck (to confirm types), blast_radius (to see what else is affected).",
  input: TestInput,
  output: TestOutput,
  options: { permission: NAME_TEST },
  execute: (input, context) =>
    Effect.gen(function* () {
      const projectRoot = path.resolve(input.projectRoot ?? projectRootOf(ctx))
      if (!withinProject(projectRoot, input.path)) {
        return yield* Effect.fail(
          new Tool.Error({ message: `test: path "${input.path}" resolves outside projectRoot "${projectRoot}"` }),
        )
      }
      yield* ctx.permission.assert({
        action: NAME_TEST,
        resources: [input.path],
        save: ["*"],
        metadata: input,
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
      const result = yield* verifier.test({
        path: input.path,
        projectRoot,
        ...(input.framework !== undefined ? { framework: input.framework } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      })
      return { output: resultFields(result, input.limit) }
    }),
})

export const makeTypecheckTool = (
  ctx: Context,
  verifier: VerifierInterface,
): Tool.Info<typeof TypecheckInput, typeof TypecheckOutput> => ({
  name: NAME_TYPECHECK,
  description:
    "Verify the project. Use when:\n" +
    "  the agent has finished editing and needs to confirm the project's types still compile.\n" +
    "Examples\n" +
    '  - "Typecheck my edits"\n' +
    '  - "Did the symbol rename break any callers?"\n' +
    "Returns\n" +
    '  { status: "passed" | "failed" | "errored", summary: {}, durationMs, cacheHit, rawOutput? }\n' +
    "Avoid when\n" +
    "  you only need a quick syntax check — the lint tool is cheaper.\n" +
    "After this, often: test (to run impacted suites), blast_radius (if failures span files).\n" +
    "Cache: 1-hour TTL on (path, package.json hash, tsconfig.json hash). Re-runs within the window return `cacheHit: true`.",
  input: TypecheckInput,
  output: TypecheckOutput,
  options: { permission: NAME_TYPECHECK },
  execute: (input, context) =>
    Effect.gen(function* () {
      const projectRoot = path.resolve(input.projectRoot ?? projectRootOf(ctx))
      if (!withinProject(projectRoot, input.path)) {
        return yield* Effect.fail(
          new Tool.Error({ message: `typecheck: path "${input.path}" resolves outside projectRoot "${projectRoot}"` }),
        )
      }
      yield* ctx.permission.assert({
        action: NAME_TYPECHECK,
        resources: [input.path ?? projectRoot],
        save: ["*"],
        metadata: input,
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
      const result = yield* verifier.typecheck({
        projectRoot,
        ...(input.path !== undefined ? { path: input.path } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      })
      return { output: resultFields(result, input.limit) }
    }),
})

export const makeLintTool = (ctx: Context, verifier: VerifierInterface): Tool.Info<typeof LintInput, typeof LintOutput> => ({
  name: NAME_LINT,
  description:
    "Verify the project. Use when:\n" +
    "  the agent has finished editing and wants to confirm lint passes before claiming done.\n" +
    "Examples\n" +
    '  - "Lint my edits"\n' +
    '  - "Does ESLint complain about the rename?"\n' +
    "Returns\n" +
    '  { status, summary: {}, durationMs, cacheHit, rawOutput?, command }\n' +
    "Avoid when\n" +
    "  you only need a type check — use banyan_typecheck instead.\n" +
    "After this, often: test (to run impacted suites), blast_radius (if many files are touched).",
  input: LintInput,
  output: LintOutput,
  options: { permission: NAME_LINT },
  execute: (input, context) =>
    Effect.gen(function* () {
      const projectRoot = path.resolve(input.projectRoot ?? projectRootOf(ctx))
      if (!withinProject(projectRoot, input.path)) {
        return yield* Effect.fail(
          new Tool.Error({ message: `lint: path "${input.path}" resolves outside projectRoot "${projectRoot}"` }),
        )
      }
      yield* ctx.permission.assert({
        action: NAME_LINT,
        resources: [input.path ?? projectRoot],
        save: ["*"],
        metadata: input,
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
      const result = yield* verifier.lint({
        projectRoot,
        ...(input.path !== undefined ? { path: input.path } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      })
      return { output: { ...resultFields(result, input.limit), command: result.command } }
    }),
})

export const makeCompileTool = (
  ctx: Context,
  verifier: VerifierInterface,
): Tool.Info<typeof CompileInput, typeof CompileOutput> => ({
  name: NAME_COMPILE,
  description:
    "Verify the project. Use when:\n" +
    "  the agent needs to confirm a file still bundles before shipping it.\n" +
    "Returns\n" +
    "  { status, summary: {}, durationMs, cacheHit, rawOutput?, command }\n" +
    "Avoid when\n" +
    "  typecheck or test already covers the change.",
  input: CompileInput,
  output: CompileOutput,
  options: { permission: NAME_COMPILE },
  execute: (input, context) =>
    Effect.gen(function* () {
      const projectRoot = path.resolve(input.projectRoot ?? projectRootOf(ctx))
      if (!withinProject(projectRoot, input.path)) {
        return yield* Effect.fail(
          new Tool.Error({ message: `compile: path "${input.path}" resolves outside projectRoot "${projectRoot}"` }),
        )
      }
      yield* ctx.permission.assert({
        action: NAME_COMPILE,
        resources: [input.path],
        save: ["*"],
        metadata: input,
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
      const result = yield* verifier.compile({
        path: input.path,
        projectRoot,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      })
      return { output: { ...resultFields(result, undefined), command: result.command } }
    }),
})

export const buildTools = (ctx: Context, verifier: VerifierInterface): readonly Tool.Info[] => [
  makeTestTool(ctx, verifier),
  makeTypecheckTool(ctx, verifier),
  makeLintTool(ctx, verifier),
  makeCompileTool(ctx, verifier),
]

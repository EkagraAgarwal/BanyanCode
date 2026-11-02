import { Rpc } from "@opencode/schema/rpc"
import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import { Effect } from "effect"
import type { Interface as VerifierInterface } from "./service.js"
import { LintInput, LintOutput, TestInput, TestOutput, TypecheckInput, TypecheckOutput, type VerifierResult } from "./types.js"

/**
 * `banyancode.verify.*` RPC namespace, mirroring the v1 routes:
 *
 *   POST /global/typecheck → verify.typecheck
 *   POST /global/test-run  → verify.test
 *   POST /global/lint      → verify.lint
 *
 * Payload/result schemas are the same ones the tools use, which is exactly
 * what the v1 route handlers did (`TypecheckInput = TypecheckTool.Input`, …).
 */

export const Definition = Rpc.define({
  id: "banyancode.verify",
  methods: {
    typecheck: { input: TypecheckInput, output: TypecheckOutput },
    test: { input: TestInput, output: TestOutput },
    lint: { input: LintInput, output: LintOutput },
  },
  events: {},
})

const resultFields = (result: VerifierResult, limit?: number) => {
  const cap = limit ?? 65_536
  const raw = result.rawOutput
  const rawOutput = cap === 0 ? undefined : raw === undefined ? undefined : raw.length <= cap ? raw : raw.slice(0, cap)
  return {
    status: result.status,
    summary: result.summary,
    durationMs: result.durationMs,
    cacheHit: result.cacheHit,
    ...(rawOutput !== undefined ? { rawOutput } : {}),
  }
}

/** The location's project root, captured when the plugin registers. */
export interface HandlerDefaults {
  readonly projectRoot: string
}

export const handlers = (verifier: VerifierInterface, defaults: HandlerDefaults): RpcHandlers<typeof Definition> => ({
  typecheck: (input: typeof TypecheckInput.Type) =>
    Effect.gen(function* () {
      const result = yield* verifier.typecheck({
        projectRoot: input.projectRoot ?? defaults.projectRoot,
        ...(input.path !== undefined ? { path: input.path } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      })
      return resultFields(result, input.limit)
    }),
  test: (input: typeof TestInput.Type) =>
    Effect.gen(function* () {
      const result = yield* verifier.test({
        path: input.path,
        projectRoot: input.projectRoot ?? defaults.projectRoot,
        ...(input.framework !== undefined ? { framework: input.framework } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      })
      return resultFields(result, input.limit)
    }),
  lint: (input: typeof LintInput.Type) =>
    Effect.gen(function* () {
      const result = yield* verifier.lint({
        projectRoot: input.projectRoot ?? defaults.projectRoot,
        ...(input.path !== undefined ? { path: input.path } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      })
      return { ...resultFields(result, input.limit), command: result.command }
    }),
})

export * as TestTool from "./test"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "node:path"
import { Banyan } from "../banyancode"
import type { Interface as PermissionV2Interface } from "../permission"
import type { Interface as VerifierServiceInterface } from "../banyancode/verifier-service"
import { traced } from "../observability/trace"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { optionalNumber } from "./tool-schema"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "banyan_test"

// File-path pattern: same as typecheck. Bun test paths can be either a file
// (`src/foo.test.ts`) or a glob (`src/foo*.test.ts`); both forms use the
// same character class.
const FILE_PATH_PATTERN = /^[a-zA-Z0-9._*?-][a-zA-Z0-9._/*?-]*$/

export const Input = Schema.Struct({
  path: Schema.String.check(
    Schema.isPattern(FILE_PATH_PATTERN, {
      identifier: "Banyan/TestPath",
      description: "Test file path or glob relative to project root",
    }),
    Schema.isMinLength(1),
    Schema.isMaxLength(512),
  ).annotate({
    description:
      "REQUIRED. Path to a test file or glob (e.g. 'src/foo.test.ts') relative to the project root. " +
      "The resolved absolute path MUST stay inside the project root; paths that escape are rejected.",
  }),
  framework: Schema.optional(Schema.Literals(["bun", "jest", "vitest", "mocha"])).annotate({
    description: "Test framework to invoke. Defaults to 'bun' (uses `bun test <path>`).",
  }),
  projectRoot: Schema.optional(Schema.String.check(Schema.isMaxLength(512))).annotate({
    description: "Project root. Defaults to the current working directory when omitted.",
  }),
  timeoutMs: optionalNumber.annotate({
    description: "Override the default 5-minute timeout in milliseconds.",
  }),
  limit: optionalNumber.annotate({
    description: "Cap the size of the returned `rawOutput` (in bytes). Defaults to 65536 (64 KB). 0 = no output.",
  }),
}).annotate({
  description:
    "Run the project's test runner (`bun test <path>` by default) and return parsed pass/fail/skip counters. " +
    "Returns a structured result so the agent does not have to grep a raw stdout stream.",
})

export const Output = Schema.Struct({
  status: Schema.Literals(["passed", "failed", "errored"]),
  summary: Schema.Record(Schema.String, Schema.Unknown),
  durationMs: Schema.Number,
  cacheHit: Schema.Boolean,
  rawOutput: Schema.optional(Schema.String),
})

const ensureInsideProjectRoot = (input: { path: string; projectRoot: string }): Effect.Effect<void, ToolFailure> => {
  const root = path.resolve(input.projectRoot)
  // Resolve from the root so a path like `src/x.test.ts` becomes an absolute
  // path inside the project. Reject if the resolution escapes.
  const resolved = path.resolve(root, input.path)
  const rel = path.relative(root, resolved)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return Effect.fail(new ToolFailure({ message: `test: path "${input.path}" resolves outside projectRoot "${root}"` }))
  }
  return Effect.void
}

export const makeTestTool = (deps: {
  readonly permission: PermissionV2Interface
  readonly verifier: VerifierServiceInterface
}) =>
  Tool.make({
    description:
      "Use when:\n" +
      "  the agent has finished editing and needs to confirm the project's tests still pass.\n" +
      "Examples\n" +
      '  - "Run my failing test"\n' +
      '  - "Did the rename break the test suite?"\n' +
      "Returns\n" +
      '  { status, summary: {passed, failed, skipped}, durationMs, cacheHit, rawOutput? }\n' +
      "Avoid when\n" +
      "  you only need a single test name — `bun test` already supports `-t <name>` via the bash tool.\n" +
      "After this, often: typecheck (to confirm types), blast_radius (to see what else is affected).",
    contract: { visibility: "public" },
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => {
      const passed = (output.summary.passed as number | undefined) ?? 0
      const failed = (output.summary.failed as number | undefined) ?? 0
      const skipped = (output.summary.skipped as number | undefined) ?? 0
      const truncated = output.rawOutput
        ? output.rawOutput.length > 4000
          ? `${output.rawOutput.slice(0, 4000)}\n…(output truncated; raise the limit or re-run with a tighter path)`
          : output.rawOutput
        : ""
      return [
        {
          type: "text",
          text: [
            `status=${output.status} passed=${passed} failed=${failed} skipped=${skipped}`,
            `durationMs=${output.durationMs} cacheHit=${output.cacheHit}`,
            truncated ? `\noutput (truncated):\n${truncated}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ]
    },
    execute: (input, context) =>
      traced(
        process.cwd(),
        context.sessionID,
        name,
        input,
        (output) =>
          `status=${output.status} passed=${(output.summary.passed as number | undefined) ?? 0} failed=${(output.summary.failed as number | undefined) ?? 0} durationMs=${output.durationMs} cacheHit=${output.cacheHit}`,
        Effect.gen(function* () {
          const projectRoot = path.resolve(input.projectRoot ?? process.cwd())
          yield* ensureInsideProjectRoot({ path: input.path, projectRoot })
          yield* deps.permission.assert({
            action: name,
            resources: [input.path],
            save: ["*"],
            metadata: input,
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
          })
          const result = yield* deps.verifier.test({
            path: input.path,
            projectRoot,
            ...(input.framework !== undefined ? { framework: input.framework } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          })
          const limit = input.limit ?? 0
          const rawOutput =
            limit === 0
              ? undefined
              : (result.rawOutput ?? "").length <= limit
                ? result.rawOutput
                : (result.rawOutput ?? "").slice(0, limit)
          return {
            status: result.status,
            summary: result.summary as Record<string, unknown>,
            durationMs: result.durationMs,
            cacheHit: result.cacheHit,
            ...(rawOutput !== undefined ? { rawOutput } : {}),
          }
        }),
      ).pipe(
        Effect.mapError((err) => (err instanceof ToolFailure ? err : new ToolFailure({ message: "banyan_test failed" }))),
      ),
  })

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const verifier = yield* Banyan.VerifierService
    yield* tools
      .register({
        [name]: makeTestTool({
          permission: permission as PermissionV2Interface,
          verifier: verifier as unknown as VerifierServiceInterface,
        }),
      })
      .pipe(Effect.orDie)
  }),
)

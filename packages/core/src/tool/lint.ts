export * as LintTool from "./lint"

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

export const name = "banyan_lint"

const FILE_PATH_PATTERN = /^[a-zA-Z0-9._/-]+$/

export const Input = Schema.Struct({
  path: Schema.optional(
    Schema.String.check(
      Schema.isPattern(FILE_PATH_PATTERN, {
        identifier: "Banyan/LintPath",
        description: "File or directory path (relative to project root; letters, digits, '.', '_', '-', '/' only)",
      }),
      Schema.isMaxLength(512),
    ),
  ).annotate({
    description:
      "Optional file or directory path relative to the project root to lint. Omit to lint the whole project. " +
      "The resolved absolute path MUST stay inside the project root; paths that escape are rejected.",
  }),
  projectRoot: Schema.optional(Schema.String.check(Schema.isMaxLength(512))).annotate({
    description: "Project root. Defaults to the current working directory when omitted.",
  }),
  timeoutMs: optionalNumber.annotate({
    description: "Override the default 2-minute timeout in milliseconds.",
  }),
  limit: optionalNumber.annotate({
    description: "Cap the size of the returned `rawOutput` (in bytes). Defaults to 65536 (64 KB). 0 = no output.",
  }),
}).annotate({
  description:
    "Run the project's lint command (`bun run lint` by default, or whatever is configured in " +
    "`banyancode.json` → `commands.lint`). Returns a structured pass/fail with the last 64 KB of output.",
})

export const Output = Schema.Struct({
  status: Schema.Literals(["passed", "failed", "errored"]),
  summary: Schema.Record(Schema.String, Schema.Unknown),
  durationMs: Schema.Number,
  cacheHit: Schema.Boolean,
  rawOutput: Schema.optional(Schema.String),
  command: Schema.String,
})

const ensureInsideProjectRoot = (input: { path?: string; projectRoot: string }): Effect.Effect<void, ToolFailure> => {
  const root = path.resolve(input.projectRoot)
  if (input.path === undefined) return Effect.void
  const resolved = path.resolve(root, input.path)
  const rel = path.relative(root, resolved)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return Effect.fail(new ToolFailure({ message: `lint: path "${input.path}" resolves outside projectRoot "${root}"` }))
  }
  return Effect.void
}

export const makeLintTool = (deps: {
  readonly permission: PermissionV2Interface
  readonly verifier: VerifierServiceInterface
}) =>
  Tool.make({
    description:
      "Use when:\n" +
      "  the agent has finished editing and wants to confirm lint passes before claiming done.\n" +
      "Examples\n" +
      '  - "Lint my edits"\n' +
      '  - "Does ESLint complain about the rename?"\n' +
      "Returns\n" +
      '  { status, summary: {}, durationMs, cacheHit, rawOutput?, command }\n' +
      "Avoid when\n" +
      "  you only need a type check — use banyan_typecheck instead.\n" +
      "After this, often: test (to run impacted suites), blast_radius (if many files are touched).",
    contract: { visibility: "public" },
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => {
      const truncated = output.rawOutput
        ? output.rawOutput.length > 4000
          ? `${output.rawOutput.slice(0, 4000)}\n…(output truncated; raise the limit or re-run with a tighter path)`
          : output.rawOutput
        : ""
      return [
        {
          type: "text",
          text: [
            `status=${output.status} command=${output.command}`,
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
        (output) => `status=${output.status} durationMs=${output.durationMs} cacheHit=${output.cacheHit}`,
        Effect.gen(function* () {
          const projectRoot = path.resolve(input.projectRoot ?? process.cwd())
          yield* ensureInsideProjectRoot({ path: input.path, projectRoot })
          yield* deps.permission.assert({
            action: name,
            resources: [input.path ?? projectRoot],
            save: ["*"],
            metadata: input,
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
          })
          const result = yield* deps.verifier.lint({
            path: input.path,
            projectRoot,
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
            command: "bun run lint",
          }
        }),
      ).pipe(
        Effect.mapError((err) => (err instanceof ToolFailure ? err : new ToolFailure({ message: "banyan_lint failed" }))),
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
        [name]: makeLintTool({
          permission: permission as PermissionV2Interface,
          verifier: verifier as unknown as VerifierServiceInterface,
        }),
      })
      .pipe(Effect.orDie)
  }),
)

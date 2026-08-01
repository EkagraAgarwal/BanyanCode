export * as TypecheckTool from "./typecheck"

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

export const name = "banyan_typecheck"

// File-path pattern: alphanumeric, dot, underscore, hyphen, slash. Rejects
// `..`, `~`, control characters, and any path that escapes the project root.
// Final defense is the resolved-path-stays-inside-projectRoot check at execute
// time (mirrors `BanyanAgentSaveInput` validation pattern from AGENTS.md).
const FILE_PATH_PATTERN = /^[a-zA-Z0-9._/-]+$/

export const Input = Schema.Struct({
  path: Schema.optional(
    Schema.String.check(
      Schema.isPattern(FILE_PATH_PATTERN, {
        identifier: "Banyan/TypecheckPath",
        description: "File path (relative to project root; letters, digits, '.', '_', '-', '/' only)",
      }),
      Schema.isMaxLength(512),
    ),
  ).annotate({
    description:
      "Optional file path relative to the project root to typecheck. Omit to typecheck the whole project. " +
      "The resolved absolute path MUST stay inside the project root; paths that escape are rejected.",
  }),
  projectRoot: Schema.optional(Schema.String.check(Schema.isMaxLength(512))).annotate({
    description: "Project root. Defaults to the current working directory when omitted.",
  }),
  timeoutMs: optionalNumber.annotate({
    description: "Override the default 5-minute timeout in milliseconds. Useful for fast-feedback loops on small projects.",
  }),
  limit: optionalNumber.annotate({
    description: "Cap the size of the returned `rawOutput` (in bytes). Defaults to 65536 (64 KB). 0 = no output.",
  }),
}).annotate({
  description:
    "Run the project's type checker (`bunx tsc --noEmit` by default, or `tsgo --noEmit` if the project " +
    "uses the TypeScript 7 native compiler). Returns a structured pass/fail with the last 64 KB of stdout+stderr. " +
    "Caches results by (path, package.json hash, tsconfig.json hash) for 1 hour.",
})

export const Output = Schema.Struct({
  status: Schema.Literals(["passed", "failed", "errored"]),
  summary: Schema.Record(Schema.String, Schema.Unknown),
  durationMs: Schema.Number,
  cacheHit: Schema.Boolean,
  rawOutput: Schema.optional(Schema.String),
})

const ensureInsideProjectRoot = (input: { path?: string; projectRoot: string }): Effect.Effect<void, ToolFailure> => {
  const root = path.resolve(input.projectRoot)
  if (input.path === undefined) return Effect.void
  // Resolve from the root so a path like `src/x.ts` becomes an absolute path
  // inside the project. Reject if the resolution escapes (../ or absolute).
  const resolved = path.resolve(root, input.path)
  const rel = path.relative(root, resolved)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return Effect.fail(new ToolFailure({ message: `typecheck: path "${input.path}" resolves outside projectRoot "${root}"` }))
  }
  return Effect.void
}

export const makeTypecheckTool = (deps: {
  readonly permission: PermissionV2Interface
  readonly verifier: VerifierServiceInterface
}) =>
  Tool.make({
    description:
      "Use when:\n" +
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
    contract: { visibility: "public" },
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => {
      const truncated = output.rawOutput
        ? output.rawOutput.length > 4000
          ? `${output.rawOutput.slice(0, 4000)}\n…(output truncated; raise the limit or re-run with a tighter path to see the rest)`
          : output.rawOutput
        : ""
      return [
        {
          type: "text",
          text: [
            `status=${output.status}`,
            `durationMs=${output.durationMs}`,
            `cacheHit=${output.cacheHit}`,
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
          const result = yield* deps.verifier.typecheck({
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
          }
        }),
      ).pipe(
        Effect.mapError((err) => (err instanceof ToolFailure ? err : new ToolFailure({ message: "banyan_typecheck failed" }))),
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
        [name]: makeTypecheckTool({
          permission: permission as PermissionV2Interface,
          verifier: verifier as unknown as VerifierServiceInterface,
        }),
      })
      .pipe(Effect.orDie)
  }),
)

// MCP verifier tool: typecheck, one test file/glob, or the project lint.
//
// Thin adapter over `banyancode.verify.{typecheck,test,lint}` (v1 names and
// parameters are preserved: kind / path / directory / framework /
// max_failures). Results are bounded: counts, status and the first-N failure
// lines, never the full log.

import path from "node:path"
import { stat } from "node:fs/promises"
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/server"
import { assertInsideRoot } from "./paths"
import { CodeToolOutputSchema, UNTRUSTED_NOTE, errorResult, invalidArguments, okResult } from "./output"
import type { McpToolResult } from "./output"
import { isRpcUnavailable, messageOf, type RpcCaller } from "./rpc"
import { Definition as VerifyRpc } from "@banyancode/plugin/rpc/verify"

export const VerifyToolName = "banyan_verify" as const

export const VerifyKinds = ["typecheck", "test", "lint"] as const
export type VerifyKind = (typeof VerifyKinds)[number]

export type VerifyRawResult = {
  status: "passed" | "failed" | "errored"
  summary: Record<string, unknown>
  durationMs: number
  cacheHit: boolean
  rawOutput?: string
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
  passed: toCount(result.summary["passed"]),
  failed: toCount(result.summary["failed"]),
  skipped: toCount(result.summary["skipped"]),
  // A clean run has no failures; the raw head of its output (the pass summary)
  // read as failure lines to clients.
  failures:
    result.status === "passed" && toCount(result.summary["failed"]) === 0
      ? []
      : firstFailures(result.rawOutput, maxFailures),
  durationMs: Math.max(0, Math.round(result.durationMs)),
  cacheHit: result.cacheHit,
})

// --- advisory command selection ---------------------------------------------
// The server's VerifierService owns execution. Selection only tells the caller
// what the project *should* run, read from its package.json.

export type VerifyCommandVia = "script" | "fallback"

export interface VerifyCommandSelection {
  readonly command: string
  readonly via: VerifyCommandVia
  readonly available: boolean
  readonly note?: string
}

export type VerifyFramework = "bun" | "jest" | "vitest" | "mocha"

export const selectVerifyCommand = (
  kind: VerifyKind,
  input?: {
    readonly scripts?: Record<string, unknown>
    readonly testPath?: string
    readonly framework?: VerifyFramework
  },
): VerifyCommandSelection => {
  const scripts = input?.scripts
  if (kind === "typecheck") {
    if (typeof scripts?.["typecheck"] === "string") {
      return { command: "bun run typecheck", via: "script", available: true }
    }
    return {
      command: "bunx tsc --noEmit",
      via: "fallback",
      available: true,
      note: "no 'typecheck' script in package.json; falling back to 'bunx tsc --noEmit'",
    }
  }
  if (kind === "test") {
    const framework = input?.framework ?? "bun"
    const target = input?.testPath ?? "."
    const command = framework === "bun" ? `bun test ${target}` : `bunx ${framework} ${target}`
    if (typeof scripts?.["test"] === "string") {
      return {
        command,
        via: "script",
        available: true,
        note: `project defines a 'test' script; the server runs '${command}' directly`,
      }
    }
    return { command, via: "fallback", available: true }
  }
  if (typeof scripts?.["lint"] === "string") {
    return { command: "bun run lint", via: "script", available: true }
  }
  return {
    command: "bun run lint",
    via: "fallback",
    available: false,
    note: "no 'lint' script in package.json and no commands.lint override is visible here; 'bun run lint' fails unless the server defines one",
  }
}

export interface PackageScripts {
  readonly scripts: Record<string, unknown>
  readonly packageManager?: string
}

// Best-effort read of the target root's package.json. Missing file or invalid
// JSON yields empty scripts — selection falls back, never throws.
export const readPackageScripts = async (projectRoot: string): Promise<PackageScripts> => {
  try {
    const raw = await Bun.file(path.join(projectRoot, "package.json")).text()
    const parsed = JSON.parse(raw) as { scripts?: unknown; packageManager?: unknown }
    const scripts =
      parsed.scripts !== null && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
        ? (parsed.scripts as Record<string, unknown>)
        : {}
    return typeof parsed.packageManager === "string"
      ? { scripts, packageManager: parsed.packageManager }
      : { scripts }
  } catch {
    return { scripts: {} }
  }
}

// Resolve the verify project root: cwd by default, or an explicit directory
// (a task worktree path arrives this way). Relative inputs stay inside cwd
// (PATH_ESCAPE otherwise); absolute inputs are allowed outside cwd by design
// (worktrees are siblings, not children) but must be an existing directory.
export const resolveVerifyRoot = async (
  cwd: string,
  directory?: string,
): Promise<{ root: string } | { error: McpToolResult }> => {
  const raw = directory ?? "."
  if (path.isAbsolute(raw)) {
    const resolved = path.resolve(raw)
    try {
      const info = await stat(resolved)
      if (!info.isDirectory()) return { error: invalidArguments(`verify directory is not a directory: ${raw}`) }
    } catch {
      return { error: invalidArguments(`verify directory does not exist: ${raw}`) }
    }
    return { root: resolved }
  }
  try {
    return { root: assertInsideRoot(cwd, raw) }
  } catch (error) {
    return {
      error: errorResult("PATH_ESCAPE", error instanceof Error ? error.message : `path escapes project root: ${raw}`),
    }
  }
}

const VerifyInput = z.object({
  kind: z
    .enum(["typecheck", "test", "lint"])
    .describe("typecheck runs the type checker, test runs the test runner for path, lint runs the project lint."),
  path: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe(
      "File path or glob relative to the project root (required for kind test; forwarded as-is — absolute paths are rejected).",
    ),
  directory: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe(
      "Project root override, e.g. a task worktree path. Relative stays inside the server directory; absolute must exist. Defaults to the server directory.",
    ),
  framework: z
    .enum(["bun", "jest", "vitest", "mocha"])
    .optional()
    .describe("Test runner for kind test. Defaults to bun."),
  max_failures: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("How many failure lines to return (first-N). Defaults to 10."),
})
type VerifyArgs = z.infer<typeof VerifyInput>

// Raw output is bounded server-side; 8 KB is plenty for the first-N lines and
// keeps the summarized result small.
const RAW_OUTPUT_LIMIT = 8_000

export type VerifyToolDeps = {
  rpc: RpcCaller
  cwd: string
  outputChars?: number
}

export function registerVerifyTool(mcp: McpServer, deps: VerifyToolDeps): void {
  mcp.registerTool(
    VerifyToolName,
    {
      title: "Run typecheck, tests, or lint",
      description:
        "Run the project's verifier (typecheck over the whole project, test for one file, lint) with the project root " +
        "defaulting to the server directory or an explicit worktree path. Returns counts plus the first-N failure " +
        `lines, never full logs. ${UNTRUSTED_NOTE}`,
      inputSchema: VerifyInput,
      outputSchema: CodeToolOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { "anthropic/maxResultSizeChars": deps.outputChars ?? 8000 },
    },
    async (args: VerifyArgs): Promise<McpToolResult> => {
      try {
        const resolved = await resolveVerifyRoot(deps.cwd, args.directory)
        if ("error" in resolved) return resolved.error
        const root = resolved.root
        if (args.kind === "test" && (args.path === undefined || args.path.length === 0)) {
          return invalidArguments(`banyan_verify kind "test" requires "path".`)
        }
        if (args.path !== undefined) {
          try {
            assertInsideRoot(root, args.path)
          } catch (error) {
            return errorResult(
              "PATH_ESCAPE",
              error instanceof Error ? error.message : `path escapes project root: ${args.path}`,
            )
          }
        }
        const { scripts, packageManager } = await readPackageScripts(root)
        const selection = selectVerifyCommand(args.kind, {
          scripts,
          ...(args.path !== undefined ? { testPath: args.path } : {}),
          ...(args.framework !== undefined ? { framework: args.framework } : {}),
        })
        const verify = deps.rpc(VerifyRpc)
        const location = { location: { directory: root } }
        const raw =
          args.kind === "typecheck"
            ? await verify.typecheck(
                {
                  projectRoot: root,
                  ...(args.path !== undefined ? { path: args.path } : {}),
                  limit: RAW_OUTPUT_LIMIT,
                },
                location,
              )
            : args.kind === "test"
              ? await verify.test(
                  {
                    path: args.path as string,
                    projectRoot: root,
                    ...(args.framework !== undefined ? { framework: args.framework } : {}),
                    limit: RAW_OUTPUT_LIMIT,
                  },
                  location,
                )
              : await verify.lint(
                  {
                    projectRoot: root,
                    ...(args.path !== undefined ? { path: args.path } : {}),
                    limit: RAW_OUTPUT_LIMIT,
                  },
                  location,
                )
        const summary = summarizeVerifyResult(
          args.kind,
          {
            status: raw.status,
            summary: raw.summary ?? {},
            durationMs: typeof raw.durationMs === "number" ? raw.durationMs : 0,
            cacheHit: raw.cacheHit ?? false,
            ...(raw.rawOutput !== undefined ? { rawOutput: raw.rawOutput } : {}),
          },
          args.max_failures ?? DEFAULT_MAX_FAILURES,
        )
        return okResult(
          {
            ...summary,
            projectRoot: root,
            command: selection.command,
            commandVia: selection.via,
            commandAvailable: selection.available,
            ...(selection.note !== undefined ? { commandNote: selection.note } : {}),
            ...(packageManager !== undefined ? { packageManager } : {}),
            ...("command" in raw && raw.command !== undefined ? { lintCommand: raw.command } : {}),
          },
          deps.outputChars,
        )
      } catch (error) {
        if (isRpcUnavailable(error)) {
          return errorResult(
            "RPC_UNAVAILABLE",
            `banyancode.verify is not registered on this server (${messageOf(error)}); load the BanyanCode plugin in banyancode.json`,
          )
        }
        return errorResult("UPSTREAM_ERROR", `banyan_verify failed: ${messageOf(error)}`)
      }
    },
  )
}

export * as McpVerifyTool from "./tools-verify"

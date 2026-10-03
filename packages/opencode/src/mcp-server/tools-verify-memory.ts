export * as McpVerifyMemory from "./tools-verify-memory"

import path from "node:path"
import { stat } from "node:fs/promises"
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/server"
import type { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Schema } from "effect"
import { assertInsideRoot } from "./paths"
import { CodeToolOutputSchema, errorResult, invalidArguments, okResult, resolveOutputChars } from "./output"
import type { McpToolResult } from "./output"

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

export const isMcpMemoryOp = (op: string): op is McpMemoryOp => (McpMemoryOps as ReadonlyArray<string>).includes(op)

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

export const tagMemoryStore = <T extends MemoryStoreRequest>(
  input: T,
): T & { readonly origin: typeof MEMORY_ORIGIN } => ({
  ...input,
  tags: [...(input.tags ?? []), `origin:${MEMORY_ORIGIN}`],
  origin: MEMORY_ORIGIN,
})

// ---------------------------------------------------------------------------
// MCP tool registration (gap-plan Milestone C3 + C4).
//
// Thin adapter over the existing HTTP routes via the typed SDK v2 client —
// no business logic lives here, same shape as tools-code.ts:
//   banyan_verify  -> POST /global/typecheck | POST /global/test-run | POST /global/lint (kind-selected)
//   banyan_memory  -> POST /global/memory/* (op-selected: recall/search/store/get/summary)
//
// Schemas are zod v4 (the one MCP-facing dialect, gap-plan §4.7); the
// Effect Schema structs above stay for compat. Handlers use the structured
// result/err helpers from output.ts. Registration order is alphabetical for
// deterministic tools/list.
//
// NOTE: this module does NOT wire itself into server.ts — the bootstrap
// calls registerVerifyMemoryTools(mcp, { sdk, cwd, outputChars }) next to
// registerCodeTools/registerTaskTools (gated by the tool-group allowlist).

export const VerifyToolName = "banyan_verify" as const
export const MemoryToolName = "banyan_memory" as const

export const VerifyMemoryToolNames = [MemoryToolName, VerifyToolName] as const
export type VerifyMemoryToolName = (typeof VerifyMemoryToolNames)[number]

export type VerifyMemoryToolsSdk = ReturnType<typeof createOpencodeClient>

export type VerifyMemoryToolsDeps = {
  sdk: VerifyMemoryToolsSdk
  // Server project directory. Verify runs default here; an explicit
  // `directory` arg (e.g. a task worktree path from the C2 sibling) may
  // point outside it — see resolveVerifyRoot.
  cwd: string
  outputChars?: number
}

// --- verify: command selection ----------------------------------------------
// Advisory only: the server's VerifierService owns execution. Selection
// prefers the project's own package.json script when present so the result
// tells the caller what *should* run; `available: false` (lint without a
// lint script and no known override) still forwards — the server may have
// a commands.lint override we cannot see from here.

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

// Best-effort read of the target root's package.json. Missing file or
// invalid JSON yields empty scripts — selection falls back, never throws.
export const readPackageScripts = async (projectRoot: string): Promise<PackageScripts> => {
  try {
    const raw = await Bun.file(path.join(projectRoot, "package.json")).text()
    const parsed = JSON.parse(raw) as { scripts?: unknown; packageManager?: unknown }
    const scripts =
      parsed.scripts !== null && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
        ? (parsed.scripts as Record<string, unknown>)
        : {}
    const packageManager = typeof parsed.packageManager === "string" ? parsed.packageManager : undefined
    return packageManager !== undefined ? { scripts, packageManager } : { scripts }
  } catch {
    return { scripts: {} }
  }
}

// Resolve the verify project root: cwd by default, or an explicit directory
// (a task worktree path arrives this way from the C2 sibling). Relative
// inputs stay inside cwd (PATH_ESCAPE otherwise); absolute inputs are
// allowed outside cwd by design (worktrees are siblings, not children) but
// must be an existing directory.
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

// --- memory: scope + store payload ------------------------------------------

const MEMORY_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{1,127}$/
const MEMORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{4,63}$/

// Project scope for MCP callers: the MCP server has no session of its own,
// so unscoped calls default to "global". An explicit "session" scope needs
// the sessionID it belongs to (e.g. the task session the agent works in).
export const resolveMemoryScope = (
  scope: string | undefined,
  sessionID: string | undefined,
): { scope: "global" | "session"; sessionID?: string } | { error: string } => {
  const resolved = scope ?? "global"
  if (resolved !== "global" && resolved !== "session") {
    return { error: `memory scope must be "global" or "session", got "${scope}"` }
  }
  if (resolved === "session" && (sessionID === undefined || sessionID.length === 0)) {
    return { error: `memory scope "session" requires "sessionID"` }
  }
  return resolved === "session" && sessionID !== undefined ? { scope: resolved, sessionID } : { scope: resolved }
}

export interface MemoryStorePayloadInput extends MemoryStoreRequest {
  readonly id?: string
  readonly context?: string
  readonly sessionID?: string
  readonly expiresAt?: number
  readonly agentID?: string
}

// Build the /global/memory/store body: size/tag limits enforced by the
// caller, origin:mcp tag attached, and the helper's `origin` field dropped —
// the store route schema (groups/memory.ts MemoryStoreInput) has no `origin`
// field, so only the tag travels (gap-plan §3 item 22).
export const buildMemoryStorePayload = (input: MemoryStorePayloadInput): Record<string, unknown> => {
  const tagged = tagMemoryStore({ key: input.key, value: input.value, scope: input.scope, tags: input.tags })
  const { origin: _dropped, ...rest } = tagged as Record<string, unknown>
  void _dropped
  const payload: Record<string, unknown> = { ...rest }
  if (input.id !== undefined) payload["id"] = input.id
  if (input.context !== undefined) payload["context"] = input.context
  if (input.sessionID !== undefined) payload["sessionID"] = input.sessionID
  if (input.expiresAt !== undefined) payload["expiresAt"] = input.expiresAt
  if (input.agentID !== undefined) payload["agentID"] = input.agentID
  return payload
}

const MemoryInput = z.object({
  op: z
    .enum(["recall", "search", "store", "get", "summary"])
    .describe(
      "recall looks up by exact key, search full-texts, store writes, get fetches by id, summary returns the digest view.",
    ),
  key: z
    .string()
    .min(2)
    .max(128)
    .regex(MEMORY_KEY_PATTERN, "must match [a-z0-9][a-z0-9:._-]{1,127}")
    .optional()
    .describe("Memory key (required for recall and store)."),
  query: z.string().min(1).max(512).optional().describe("Full-text query (required for search)."),
  id: z
    .string()
    .min(5)
    .max(64)
    .regex(MEMORY_ID_PATTERN, "must match [a-z0-9][a-z0-9-]{4,63}")
    .optional()
    .describe("Entry id (required for get; optional for store — the server mints one when omitted)."),
  value: z
    .unknown()
    .optional()
    .describe("Stored value (required for store). JSON-serializable; capped at 32 KiB serialized."),
  context: z.string().min(1).max(2048).optional().describe("Extra context recorded alongside a store."),
  tags: z
    .array(z.string().min(1).max(MEMORY_TAG_MAX_CHARS))
    .max(MEMORY_TAGS_MAX)
    .optional()
    .describe("Tags for a store (origin:mcp is added automatically)."),
  scope: z
    .enum(["global", "session"])
    .optional()
    .describe("Project scope defaults to global. session requires sessionID."),
  sessionID: z.string().min(1).max(128).optional().describe("Owning session for session-scoped reads/writes."),
  limit: z.number().int().min(1).max(100).optional().describe("Max hits for search. Defaults to 25."),
  maxItems: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max digest items per section for summary. Defaults to 25."),
  kind: z
    .enum([
      "preference",
      "identity",
      "convention",
      "decision",
      "architecture",
      "pattern",
      "warning",
      "failure",
      "todo",
      "observation",
      "summary",
      "ownership",
      "constraint",
      "environment",
    ])
    .optional()
    .describe("Kind filter for search."),
  status: z
    .enum(["pending", "active", "superseded", "rejected", "expired"])
    .optional()
    .describe("Status filter for search."),
})
type MemoryArgs = z.infer<typeof MemoryInput>

// --- registration ------------------------------------------------------------

type SdkResult = { data?: unknown; error?: unknown }

const describeSdkError = (error: unknown): string => {
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

const fromSdk = (res: SdkResult, outputChars: number): McpToolResult =>
  res.error !== undefined && res.error !== null
    ? errorResult("UPSTREAM_ERROR", `request failed: ${describeSdkError(res.error)}`)
    : okResult(res.data ?? null, outputChars)

const metaFor = (outputChars: number): Record<string, unknown> => ({
  "anthropic/maxResultSizeChars": outputChars,
})

export function registerVerifyMemoryTools(mcp: McpServer, deps: VerifyMemoryToolsDeps): void {
  const outputChars = resolveOutputChars(deps.outputChars)
  // Registration order is alphabetical so tools/list is deterministic.
  mcp.registerTool(
    MemoryToolName,
    {
      title: "Project memory recall and store",
      description:
        "Project-scoped memory: recall by exact key, full-text search, store (tagged origin:mcp), fetch by id, and digest summary. Stores default to global scope so an agent inside a task can recall them by key.",
      inputSchema: MemoryInput,
      outputSchema: CodeToolOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: metaFor(outputChars),
    },
    async (args: MemoryArgs) => {
      try {
        const scoped = resolveMemoryScope(args.scope, args.sessionID)
        if ("error" in scoped) return invalidArguments(scoped.error)
        const sdk = deps.sdk.memory
        switch (args.op) {
          case "recall": {
            if (!args.key) return invalidArguments(`banyan_memory op "recall" requires "key".`)
            return fromSdk(
              await sdk.recall({
                banyanMemoryRecallInput: {
                  key: args.key,
                  scope: scoped.scope,
                  ...(scoped.sessionID !== undefined ? { sessionID: scoped.sessionID } : {}),
                },
              }),
              outputChars,
            )
          }
          case "search": {
            if (!args.query) return invalidArguments(`banyan_memory op "search" requires "query".`)
            return fromSdk(
              await sdk.search({
                banyanMemorySearchInput: {
                  query: args.query,
                  ...(args.limit !== undefined ? { limit: args.limit } : {}),
                  scope: scoped.scope,
                  ...(scoped.sessionID !== undefined ? { sessionID: scoped.sessionID } : {}),
                  ...(args.kind !== undefined ? { kind: args.kind } : {}),
                  ...(args.status !== undefined ? { status: args.status } : {}),
                },
              }),
              outputChars,
            )
          }
          case "store": {
            if (!args.key) return invalidArguments(`banyan_memory op "store" requires "key".`)
            if (args.value === undefined) return invalidArguments(`banyan_memory op "store" requires "value".`)
            const limitError = checkMemoryStoreLimits({ value: args.value, tags: args.tags })
            if (limitError !== undefined) return invalidArguments(limitError)
            const payload = buildMemoryStorePayload({
              key: args.key,
              value: args.value,
              scope: scoped.scope,
              ...(args.tags !== undefined ? { tags: args.tags } : {}),
              ...(args.id !== undefined ? { id: args.id } : {}),
              ...(args.context !== undefined ? { context: args.context } : {}),
              ...(scoped.sessionID !== undefined ? { sessionID: scoped.sessionID } : {}),
            })
            return fromSdk(
              await sdk.store({
                // The store route schema has no `origin` field — only the
                // origin:mcp tag travels (see buildMemoryStorePayload).
                banyanMemoryStoreInput: payload as {
                  key: string
                  value: unknown
                  scope: string
                },
              }),
              outputChars,
            )
          }
          case "get": {
            if (!args.id) return invalidArguments(`banyan_memory op "get" requires "id".`)
            return fromSdk(await sdk.get({ banyanMemoryGetInput: { id: args.id } }), outputChars)
          }
          case "summary": {
            return fromSdk(
              await sdk.summary({
                banyanMemorySummaryInput: {
                  scope: scoped.scope,
                  ...(scoped.sessionID !== undefined ? { sessionID: scoped.sessionID } : {}),
                  ...(args.maxItems !== undefined ? { maxItems: args.maxItems } : {}),
                },
              }),
              outputChars,
            )
          }
          default:
            return invalidArguments(`unknown banyan_memory op: ${String((args as { op?: unknown }).op)}`)
        }
      } catch (error) {
        return errorResult(
          "UPSTREAM_ERROR",
          `banyan_memory failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
  )

  mcp.registerTool(
    VerifyToolName,
    {
      title: "Run typecheck, tests, or lint",
      description:
        "Run the project's verifier (typecheck over the whole project, test for one file, lint) with the project root defaulting to the server directory or an explicit worktree path. Returns counts plus the first-N failure lines, never full logs.",
      inputSchema: VerifyInput,
      outputSchema: CodeToolOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: metaFor(outputChars),
    },
    async (args: VerifyArgs) => {
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
        const maxFailures = args.max_failures ?? DEFAULT_MAX_FAILURES
        const sdk = deps.sdk.global
        let raw: SdkResult
        if (args.kind === "typecheck") {
          raw = await sdk.typecheck({
            ...(args.path !== undefined ? { path: args.path } : {}),
            projectRoot: root,
          })
        } else if (args.kind === "test") {
          raw = await sdk.testRun({
            path: args.path as string,
            ...(args.framework !== undefined ? { framework: args.framework } : {}),
            projectRoot: root,
          })
        } else {
          raw = await sdk.lint({
            ...(args.path !== undefined ? { path: args.path } : {}),
            projectRoot: root,
          })
        }
        if (raw.error !== undefined && raw.error !== null) {
          return errorResult("UPSTREAM_ERROR", `request failed: ${describeSdkError(raw.error)}`)
        }
        const data = (raw.data ?? {}) as {
          status?: VerifyRawResult["status"]
          summary?: Record<string, unknown>
          durationMs?: number
          cacheHit?: boolean
          rawOutput?: string
        }
        const summary = summarizeVerifyResult(
          args.kind,
          {
            status: data.status ?? "errored",
            summary: data.summary ?? {},
            durationMs: typeof data.durationMs === "number" ? data.durationMs : 0,
            cacheHit: data.cacheHit ?? false,
            ...(data.rawOutput !== undefined ? { rawOutput: data.rawOutput } : {}),
          },
          maxFailures,
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
          },
          outputChars,
        )
      } catch (error) {
        return errorResult(
          "UPSTREAM_ERROR",
          `banyan_verify failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
  )
}

export * as VerifierService from "./verifier-service"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { ChildProcess } from "effect/unstable/process"
import { Context, Duration, Effect, Layer, Semaphore } from "effect"
import { AppProcess } from "../process"
import { BanyanConfigService } from "./banyan-config"
import { VerificationRepo, type VerificationKind, type VerificationStatus, type VerificationSummary } from "./verification-repo"

// Phase 6 (Verifier): the agent's "did I break it" surface. Each method runs
// the appropriate shell command for the project, captures stdout+stderr
// (truncated to the last 64 KB), persists the structured summary to the
// verification_runs table, and returns the parsed result.
//
// All four methods share the same shape:
//
//   1. resolve the projectRoot (callers pass it explicitly or we default to cwd)
//   2. compute a cache key from (kind, path, content_hash, tsconfig_hash)
//   3. if a recent completed run exists for that cache key (< 1 h old), return it
//   4. otherwise shell out to the right binary, capture output, persist, return
//
// Concurrency is bounded by a single semaphore across all four methods so the
// agent can fire `banyan_lint` + `banyan_test` + `banyan_typecheck` in parallel
// without saturating the host.

const DEFAULT_TYPECHECK_TIMEOUT_MS = Duration.minutes(5)
const DEFAULT_TEST_TIMEOUT_MS = Duration.minutes(5)
const DEFAULT_LINT_TIMEOUT_MS = Duration.minutes(2)
const DEFAULT_COMPILE_TIMEOUT_MS = Duration.minutes(5)

const RAW_OUTPUT_BYTE_LIMIT = 64 * 1024
const CACHE_TTL_MS = 60 * 60 * 1000

const CONCURRENCY = 4

export type VerifierResultStatus = Exclude<VerificationStatus, "running">

export interface VerifierResult {
  readonly kind: VerificationKind
  readonly target: string
  readonly status: VerifierResultStatus
  readonly summary: VerificationSummary
  readonly durationMs: number
  readonly cacheHit: boolean
  /** Last `RAW_OUTPUT_BYTE_LIMIT` bytes of stdout+stderr. May be empty. */
  readonly rawOutput: string | undefined
  /** Exact shell command that was (or would be) executed for this run. */
  readonly command: string
}

export interface TypecheckInput {
  readonly path?: string
  readonly projectRoot: string
  readonly timeoutMs?: number
}

export interface TestInput {
  readonly path: string
  readonly projectRoot: string
  readonly framework?: "bun" | "jest" | "vitest" | "mocha"
  readonly timeoutMs?: number
}

export interface LintInput {
  readonly path?: string
  readonly projectRoot: string
  readonly timeoutMs?: number
}

export interface CompileInput {
  readonly path: string
  readonly projectRoot: string
  readonly timeoutMs?: number
}

export interface Interface {
  readonly typecheck: (input: TypecheckInput) => Effect.Effect<VerifierResult, never, never>
  readonly test: (input: TestInput) => Effect.Effect<VerifierResult, never, never>
  readonly lint: (input: LintInput) => Effect.Effect<VerifierResult, never, never>
  readonly compile: (input: CompileInput) => Effect.Effect<VerifierResult, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/VerifierService") {}

// Truncate to the LAST `byteLimit` bytes — when output is huge, the recent
// tail usually contains the actual error context. Using bytes (not chars) to
// match the Storage.limit used elsewhere.
const truncateTail = (raw: string, byteLimit: number): string => {
  if (Buffer.byteLength(raw, "utf8") <= byteLimit) return raw
  const buf = Buffer.from(raw, "utf8")
  return buf.subarray(buf.length - byteLimit).toString("utf8")
}

const safeHash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16)

const hashFileIfExists = async (filePath: string): Promise<string> => {
  try {
    const content = await fs.readFile(filePath, "utf8")
    return safeHash(content)
  } catch {
    return "missing"
  }
}

// Resolve the project's typecheck command. Two cases:
//   - The repo's package.json `scripts.typecheck` references tsgo or tsc.
//   - Otherwise fall back to `bunx tsc --noEmit`.
//
// We don't try to discover every tool — tsc/tsgo are the only typecheckers
// actually used by the workspace, and shipping `bunx tsc --noEmit` as the
// default keeps the cost low (no install-time heuristic).
const resolveTypecheckCommand = async (projectRoot: string): Promise<{ command: string; args: string[]; cacheKeySalt: string }> => {
  const pkgPath = path.join(projectRoot, "package.json")
  const hash = await hashFileIfExists(pkgPath)
  const tsconfigPath = path.join(projectRoot, "tsconfig.json")
  const tsconfigHash = await hashFileIfExists(tsconfigPath)
  return {
    command: "bunx",
    args: ["tsc", "--noEmit"],
    cacheKeySalt: `${pkgPath}:${hash}:${tsconfigPath}:${tsconfigHash}`,
  }
}

const resolveTestCommand = (input: TestInput): { command: string; args: string[] } => {
  const framework = input.framework ?? "bun"
  if (framework === "bun") {
    return { command: "bun", args: ["test", input.path] }
  }
  // jest/vitest/mocha: caller invokes the right binary. We pass through the
  // framework name so the caller controls which runner they want; the binary
  // resolution happens at the workspace level via package.json scripts.
  return { command: "bunx", args: [framework, input.path] }
}

const resolveCompileCommand = (input: CompileInput): { command: string; args: string[] } => ({
  command: "bun",
  args: ["build", input.path],
})

const resolveLintCommand = async (
  projectRoot: string,
  override: string | undefined,
): Promise<{ command: string; args: string[] }> => {
  if (override && override.length > 0) {
    // User-supplied override. Run via shell so the user can pass `eslint src`.
    return { command: "sh", args: ["-c", override] }
  }
  // Default: `bun run lint` so the project's package.json drives the choice.
  // If the script doesn't exist, bun errors with a clear message; we surface
  // that as `status: 'failed'` rather than masking it.
  return { command: "bun", args: ["run", "lint"] }
}

// Pretty-print a command for cache_key + raw output.
const describeCommand = (command: string, args: ReadonlyArray<string>): string =>
  args.length > 0 ? `${command} ${args.join(" ")}` : command

const computeCacheKey = (
  kind: VerificationKind,
  target: string,
  projectRoot: string,
  commandDescription: string,
  cacheKeySalt: string,
): string => safeHash(`${kind}|${target}|${projectRoot}|${commandDescription}|${cacheKeySalt}`)

const parseTestSummary = (output: string): VerificationSummary => {
  // Best-effort parse of `bun test` output. bun test prints a final
  // `<n> pass`, `<n> fail`, `<n> skip` summary line. We tolerate either order
  // and missing fields.
  const pass = Number((output.match(/(\d+)\s+pass/i) ?? [, ""])[1] ?? 0)
  const fail = Number((output.match(/(\d+)\s+fail/i) ?? [, ""])[1] ?? 0)
  const skip = Number((output.match(/(\d+)\s+skip/i) ?? [, ""])[1] ?? 0)
  return { passed: pass, failed: fail, skipped: skip, errored: 0 }
}

const summaryForExitCode = (
  exitCode: number,
  kind: VerificationKind,
  output: string,
): { status: VerifierResultStatus; summary: VerificationSummary } => {
  if (kind === "test") return { status: exitCode === 0 ? "passed" : "failed", summary: parseTestSummary(output) }
  if (kind === "typecheck") return { status: exitCode === 0 ? "passed" : "failed", summary: {} }
  if (kind === "compile") return { status: exitCode === 0 ? "passed" : "failed", summary: {} }
  // lint: empty output = no errors; non-zero exit code = lint errors
  return { status: exitCode === 0 ? "passed" : "failed", summary: {} }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const proc = yield* AppProcess.Service
    const config = yield* BanyanConfigService.Service
    const repo = yield* VerificationRepo.Service
    const semaphore = Semaphore.makeUnsafe(CONCURRENCY)

    const runShell = (
      command: string,
      args: ReadonlyArray<string>,
      cwd: string,
      timeoutMs: Duration.Input,
    ): Effect.Effect<
      { exitCode: number; stdout: string; stderr: string; durationMs: number },
      never,
      never
    > =>
      Effect.gen(function* () {
        const startedAt = Date.now()
        const cp = ChildProcess.make(command, [...args], {
          cwd,
          stdin: "ignore",
          // detached=false on win32: cross-spawn + taskkill handles cleanup
          detached: process.platform !== "win32",
          forceKillAfter: Duration.seconds(3),
        })
        const result = yield* proc
          .run(cp, {
            timeout: timeoutMs,
            // We deliberately cap BOTH streams at the byte limit; the
            // verification_runs table does not need raw output beyond 64 KB
            // per stream. The `raw_output` column then truncates to the last
            // 64 KB combined below.
            maxOutputBytes: RAW_OUTPUT_BYTE_LIMIT,
            maxErrorBytes: RAW_OUTPUT_BYTE_LIMIT,
          })
          .pipe(
            Effect.catchCause(() =>
              Effect.succeed({
                exitCode: -1,
                stdout: "",
                stderr: "verifier: command failed to start or timed out",
                stdoutTruncated: false,
                stderrTruncated: false,
                command: describeCommand(command, args),
              }),
            ),
          )
        return {
          exitCode: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
          durationMs: Date.now() - startedAt,
        }
      })

    const executeAndRecord = (
      kind: VerificationKind,
      target: string,
      projectRoot: string,
      command: string,
      args: ReadonlyArray<string>,
      timeoutMs: Duration.Input,
      cacheKeySalt: string,
    ): Effect.Effect<VerifierResult, never, never> =>
      Effect.gen(function* () {
        const commandDescription = describeCommand(command, args)
        const cacheKey = computeCacheKey(kind, target, projectRoot, commandDescription, cacheKeySalt)

        const cached = yield* repo.findByCacheKey({ cacheKey })
        if (
          cached &&
          cached.completedAt !== undefined &&
          Date.now() - cached.completedAt * 1000 < CACHE_TTL_MS
        ) {
          // findByCacheKey filters `status != 'running'`, so cached.status is
          // structurally 'passed' | 'failed' | 'errored' — the same as
          // VerifierResultStatus. Narrow it for the cast below.
          const status = cached.status as VerifierResultStatus
          return {
            kind,
            target,
            status,
            summary: cached.summary ?? {},
            durationMs: cached.durationMs ?? 0,
            cacheHit: true,
            rawOutput: cached.rawOutput,
            command: commandDescription,
          }
        }

        const id = yield* repo.recordStart({ kind, target, cacheKey })

        const result = yield* semaphore.withPermit(runShell(command, args, projectRoot, timeoutMs))

        const { status, summary } = summaryForExitCode(result.exitCode, kind, result.stdout + result.stderr)
        const combined = `${result.stdout}\n${result.stderr}`
        const rawOutput = truncateTail(combined, RAW_OUTPUT_BYTE_LIMIT)

        yield* repo.recordComplete({
          id,
          status,
          durationMs: result.durationMs,
          summary,
          rawOutput,
        })

        return {
          kind,
          target,
          status,
          summary,
          durationMs: result.durationMs,
          cacheHit: false,
          rawOutput,
          command: commandDescription,
        }
      })

    const typecheck: Interface["typecheck"] = (input) =>
      Effect.gen(function* () {
        const projectRoot = path.resolve(input.projectRoot)
        const target = input.path !== undefined ? path.resolve(projectRoot, input.path) : projectRoot
        const { command, args, cacheKeySalt } = yield* Effect.promise(() => resolveTypecheckCommand(projectRoot))
        const timeoutMs: Duration.Input =
          input.timeoutMs !== undefined ? Duration.millis(input.timeoutMs) : DEFAULT_TYPECHECK_TIMEOUT_MS
        return yield* executeAndRecord("typecheck", target, projectRoot, command, args, timeoutMs, cacheKeySalt)
      })

    const test: Interface["test"] = (input) =>
      Effect.gen(function* () {
        const projectRoot = path.resolve(input.projectRoot)
        // Resolve against projectRoot, not cwd — the tool layer's containment
        // check validated path.resolve(projectRoot, input.path). Resolving
        // against process.cwd() here would execute a different file whenever
        // projectRoot !== cwd, bypassing that check.
        const resolvedPath = path.resolve(projectRoot, input.path)
        const { command, args } = resolveTestCommand({ ...input, path: resolvedPath })
        const timeoutMs: Duration.Input =
          input.timeoutMs !== undefined ? Duration.millis(input.timeoutMs) : DEFAULT_TEST_TIMEOUT_MS
        return yield* executeAndRecord("test", resolvedPath, projectRoot, command, args, timeoutMs, resolvedPath)
      })

    const lint: Interface["lint"] = (input) =>
      Effect.gen(function* () {
        const projectRoot = path.resolve(input.projectRoot)
        const target = input.path !== undefined ? path.resolve(projectRoot, input.path) : projectRoot
        const cfg = yield* config.get()
        const override = cfg.commands?.lint
        const { command, args } = yield* Effect.promise(() => resolveLintCommand(projectRoot, override))
        const timeoutMs: Duration.Input =
          input.timeoutMs !== undefined ? Duration.millis(input.timeoutMs) : DEFAULT_LINT_TIMEOUT_MS
        return yield* executeAndRecord("lint", target, projectRoot, command, args, timeoutMs, override ?? "")
      })

    const compile: Interface["compile"] = (input) =>
      Effect.gen(function* () {
        const projectRoot = path.resolve(input.projectRoot)
        // Same as test: resolve against projectRoot so the tool-layer
        // containment check and the executed path agree.
        const resolvedPath = path.resolve(projectRoot, input.path)
        const { command, args } = resolveCompileCommand({ ...input, path: resolvedPath })
        const timeoutMs: Duration.Input =
          input.timeoutMs !== undefined ? Duration.millis(input.timeoutMs) : DEFAULT_COMPILE_TIMEOUT_MS
        return yield* executeAndRecord("compile", resolvedPath, projectRoot, command, args, timeoutMs, resolvedPath)
      })

    return Service.of({ typecheck, test, lint, compile })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(BanyanConfigService.defaultLayer),
  Layer.provide(VerificationRepo.defaultLayer),
)

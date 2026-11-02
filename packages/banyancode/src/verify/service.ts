import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Semaphore } from "effect"
import type { Interface as ConfigInterface } from "../config/service.js"
import type { Interface as StorageInterface } from "../storage/service.js"
import type {
  CompileInput,
  LintInput,
  TestInput,
  TypecheckInput,
  VerificationKind,
  VerificationStatus,
  VerificationSummary,
  VerifierResult,
} from "./types.js"

/**
 * Verifier, ported from v1 `packages/core/src/banyancode/verifier-service.ts`.
 *
 * Responsibilities:
 *   1. resolve the project root and the concrete command
 *      (`banyancode.json` → `commands.{typecheck,test,lint,compile}` wins,
 *      otherwise Bun/pnpm/yarn/npm detection + package.json scripts),
 *   2. spawn a real process with a timeout and a 64 KB output cap,
 *   3. persist the structured result in `verification_runs` and serve a
 *      one-hour cache hit for the same (kind, target, command, config hash).
 *
 * Concurrency is bounded by one semaphore across every kind so an agent firing
 * typecheck + test + lint concurrently can't saturate the host.
 */

const DEFAULT_TIMEOUT_MS: Record<VerificationKind, number> = {
  typecheck: 5 * 60 * 1000,
  test: 5 * 60 * 1000,
  lint: 2 * 60 * 1000,
  compile: 5 * 60 * 1000,
}

const RAW_OUTPUT_BYTE_LIMIT = 64 * 1024
const CACHE_TTL_SECONDS = 60 * 60
const CONCURRENCY = 4

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm"

export interface ProjectInfo {
  readonly root: string
  readonly packageManager: PackageManager
  readonly scripts: Readonly<Record<string, string>>
  readonly devDependencies: Readonly<Record<string, string>>
}

export interface Command {
  readonly command: string
  readonly args: readonly string[]
  /** Run through the platform shell. Used for user-supplied `commands.*` lines. */
  readonly shell: boolean
  readonly description: string
}

export interface Interface {
  readonly detect: (projectRoot: string) => Effect.Effect<ProjectInfo>
  readonly typecheck: (input: TypecheckInput) => Effect.Effect<VerifierResult>
  readonly test: (input: TestInput) => Effect.Effect<VerifierResult>
  readonly lint: (input: LintInput) => Effect.Effect<VerifierResult>
  readonly compile: (input: CompileInput) => Effect.Effect<VerifierResult>
}

const truncateTail = (raw: string, byteLimit: number): string => {
  if (Buffer.byteLength(raw, "utf8") <= byteLimit) return raw
  const buffer = Buffer.from(raw, "utf8")
  return buffer.subarray(buffer.length - byteLimit).toString("utf8")
}

const safeHash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16)

const describeCommand = (command: Command): string =>
  command.shell
    ? command.command
    : command.args.length > 0
      ? `${command.command} ${command.args.join(" ")}`
      : command.command

export const withinProject = (projectRoot: string, candidate?: string): boolean => {
  if (candidate === undefined) return true
  const root = path.resolve(projectRoot)
  const resolved = path.resolve(root, candidate)
  const relative = path.relative(root, resolved)
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

const detectProject = (projectRoot: string): Effect.Effect<ProjectInfo> =>
  Effect.gen(function* () {
    const root = path.resolve(projectRoot)
    const text = yield* Effect.promise(() => readFile(path.join(root, "package.json"), "utf8")).pipe(
      Effect.orElseSucceed(() => ""),
    )
    let scripts: Record<string, string> = {}
    let devDependencies: Record<string, string> = {}
    if (text) {
      try {
        const parsed = JSON.parse(text) as {
          scripts?: Record<string, string>
          devDependencies?: Record<string, string>
        }
        scripts = parsed.scripts ?? {}
        devDependencies = parsed.devDependencies ?? {}
      } catch {
        scripts = {}
        devDependencies = {}
      }
    }
    const packageManager: PackageManager = existsSync(path.join(root, "bun.lock"))
      ? "bun"
      : existsSync(path.join(root, "bun.lockb"))
        ? "bun"
        : existsSync(path.join(root, "pnpm-lock.yaml"))
          ? "pnpm"
          : existsSync(path.join(root, "yarn.lock"))
            ? "yarn"
            : existsSync(path.join(root, "package-lock.json"))
              ? "npm"
              : "bun"
    return { root, packageManager, scripts, devDependencies }
  })

const packageManagerRun = (info: ProjectInfo, script: string): Command => ({
  command: info.packageManager,
  args: ["run", script],
  shell: false,
  description: `${info.packageManager} run ${script}`,
})

const execCommand = (info: ProjectInfo, binary: string, args: readonly string[]): Command => {
  const usePm = info.packageManager === "pnpm" || info.packageManager === "yarn"
  const command = usePm ? info.packageManager : info.packageManager === "npm" ? "npx" : "bunx"
  const prefix = usePm ? ["exec", binary, ...args] : [binary, ...args]
  return {
    command,
    args: prefix,
    shell: false,
    description: `${command} ${prefix.join(" ")}`,
  }
}

const overrideCommand = (override: string | undefined): Command | undefined =>
  override && override.trim().length > 0
    ? { command: override, args: [], shell: true, description: override.trim() }
    : undefined

const resolveTypecheckCommand = (info: ProjectInfo, override: string | undefined): Command => {
  const forced = overrideCommand(override)
  if (forced) return forced
  if (info.scripts.typecheck) return packageManagerRun(info, "typecheck")
  const usesTsgo =
    info.devDependencies["@typescript/native-preview"] !== undefined ||
    info.scripts.typecheck?.includes("tsgo") === true
  return usesTsgo
    ? { command: "bunx", args: ["tsgo", "--noEmit"], shell: false, description: "bunx tsgo --noEmit" }
    : { command: "bunx", args: ["tsc", "--noEmit"], shell: false, description: "bunx tsc --noEmit" }
}

const resolveTestCommand = (
  info: ProjectInfo,
  input: TestInput,
  resolvedPath: string,
  override: string | undefined,
): Command => {
  const forced = overrideCommand(override)
  if (forced) return forced
  const framework = input.framework ?? "bun"
  if (framework === "bun") {
    return { command: "bun", args: ["test", resolvedPath], shell: false, description: `bun test ${resolvedPath}` }
  }
  return execCommand(info, framework, [resolvedPath])
}

const resolveLintCommand = (info: ProjectInfo, override: string | undefined): Command => {
  const forced = overrideCommand(override)
  if (forced) return forced
  if (info.scripts.lint) return packageManagerRun(info, "lint")
  return { command: "bun", args: ["run", "lint"], shell: false, description: "bun run lint" }
}

const resolveCompileCommand = (
  info: ProjectInfo,
  resolvedPath: string,
  override: string | undefined,
): Command => {
  const forced = overrideCommand(override)
  if (forced) return forced
  return { command: "bun", args: ["build", resolvedPath], shell: false, description: `bun build ${resolvedPath}` }
}

interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
}

/**
 * Spawn a real process. Both streams are capped while streaming so a runaway
 * command can't balloon memory; the stored result keeps the last 64 KB.
 */
export const runProcess = (
  command: Command,
  cwd: string,
  timeoutMs: number,
  byteLimit = RAW_OUTPUT_BYTE_LIMIT,
): Effect.Effect<ProcessResult> =>
  Effect.callback<ProcessResult>((resume, signal) => {
    const startedAt = Date.now()
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (exitCode: number, extra?: string) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resume(
        Effect.succeed({
          exitCode,
          stdout,
          stderr: extra ? `${stderr}\n${extra}` : stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
        }),
      )
    }

    const child = command.shell
      ? spawn(command.command, { cwd, shell: true, windowsHide: true, env: process.env, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(command.command, [...command.args], {
          cwd,
          shell: false,
          windowsHide: true,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        })

    timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, Math.max(1, timeoutMs))

    const onAbort = () => child.kill("SIGKILL")
    signal.addEventListener("abort", onAbort, { once: true })

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
      if (stdout.length > byteLimit * 4) stdout = truncateTail(stdout, byteLimit * 2)
    })
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
      if (stderr.length > byteLimit * 4) stderr = truncateTail(stderr, byteLimit * 2)
    })
    child.on("error", (error) => finish(-1, `verifier: ${error.message}`))
    child.on("close", (code) => finish(code ?? -1, timedOut ? "verifier: command timed out" : undefined))
  })

const parseTestSummary = (output: string): VerificationSummary => {
  const pass = Number((output.match(/(\d+)\s+pass/i) ?? [, ""])[1] ?? 0)
  const fail = Number((output.match(/(\d+)\s+fail/i) ?? [, ""])[1] ?? 0)
  const skip = Number((output.match(/(\d+)\s+skip/i) ?? [, ""])[1] ?? 0)
  return { passed: pass, failed: fail, skipped: skip, errored: 0 }
}

const summaryFor = (
  kind: VerificationKind,
  exitCode: number,
  output: string,
): { status: VerificationStatus; summary: VerificationSummary } => {
  if (kind === "test") return { status: exitCode === 0 ? "passed" : "failed", summary: parseTestSummary(output) }
  return { status: exitCode === 0 ? "passed" : "failed", summary: {} }
}

interface CachedRow {
  readonly status: string
  readonly duration_ms: number | null
  readonly summary: string | null
  readonly raw_output: string | null
  readonly completed_at: number | null
}

export interface Options {
  readonly storage: StorageInterface
  readonly config: ConfigInterface
  /** Project root used when a tool/RPC call omits `projectRoot`. */
  readonly projectRoot?: string
  /** @internal test seam for the concurrency bound. */
  readonly concurrency?: number
}

export const make = (options: Options): Interface => {
  const semaphore = Semaphore.makeUnsafe(options.concurrency ?? CONCURRENCY)

  const resolveProjectRoot = (input: { readonly projectRoot?: string }): string => {
    const root = input.projectRoot ?? options.projectRoot
    if (root === undefined) throw new Error("verification requires a projectRoot")
    return path.resolve(root)
  }

  const recordStart = (kind: VerificationKind, target: string, cacheKey: string): Effect.Effect<number> =>
    Effect.gen(function* () {
      const rows = yield* options.storage
        .query<{ id: number }>(
          `INSERT INTO verification_runs (kind, target, status, started_at, cache_key)
           VALUES (?, ?, 'running', ?, ?)
           RETURNING id`,
          [kind, target, Math.floor(Date.now() / 1000), cacheKey],
        )
        .pipe(Effect.orElseSucceed(() => []))
      return rows[0]?.id ?? -1
    })

  const recordComplete = (input: {
    id: number
    status: VerificationStatus
    durationMs: number
    summary: VerificationSummary
    rawOutput: string
  }): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (input.id < 0) return
      yield* options.storage
        .query(
          `UPDATE verification_runs
           SET status = ?, completed_at = ?, duration_ms = ?, summary = ?, raw_output = ?
           WHERE id = ?`,
          [
            input.status,
            Math.floor(Date.now() / 1000),
            input.durationMs,
            JSON.stringify(input.summary),
            input.rawOutput,
            input.id,
          ],
        )
        .pipe(Effect.orElseSucceed(() => []))
    })

  const findCached = (cacheKey: string): Effect.Effect<CachedRow | undefined> =>
    Effect.gen(function* () {
      const rows = yield* options.storage
        .query<CachedRow>(
          `SELECT status, duration_ms, summary, raw_output, completed_at
           FROM verification_runs
           WHERE cache_key = ? AND completed_at IS NOT NULL AND status != 'running'
           ORDER BY completed_at DESC
           LIMIT 1`,
          [cacheKey],
        )
        .pipe(Effect.orElseSucceed(() => []))
      const row = rows[0]
      if (!row || row.completed_at === null) return undefined
      const age = Math.floor(Date.now() / 1000) - row.completed_at
      return age >= 0 && age < CACHE_TTL_SECONDS ? row : undefined
    })

  const configSignature = (): Effect.Effect<string> =>
    Effect.gen(function* () {
      const loaded = yield* options.config.get()
      return safeHash(JSON.stringify(loaded.config.commands ?? {}))
    })

  const execute = (input: {
    kind: VerificationKind
    target: string
    projectRoot: string
    command: Command
    timeoutMs: number
  }): Effect.Effect<VerifierResult> =>
    Effect.gen(function* () {
      const description = describeCommand(input.command)
      const configHash = yield* configSignature()
      const cacheKey = safeHash(
        `${input.kind}|${input.target}|${input.projectRoot}|${description}|${configHash}`,
      )

      const cached = yield* findCached(cacheKey)
      if (cached) {
        let summary: VerificationSummary = {}
        if (cached.summary) {
          try {
            summary = JSON.parse(cached.summary) as VerificationSummary
          } catch {
            summary = {}
          }
        }
        return {
          kind: input.kind,
          target: input.target,
          status: cached.status as VerificationStatus,
          summary,
          durationMs: cached.duration_ms ?? 0,
          cacheHit: true,
          rawOutput: cached.raw_output ?? undefined,
          command: description,
        }
      }

      const id = yield* recordStart(input.kind, input.target, cacheKey)
      const result = yield* semaphore.withPermit(
        runProcess(input.command, input.projectRoot, input.timeoutMs),
      )
      const combined = `${result.stdout}\n${result.stderr}`
      const rawOutput = truncateTail(combined, RAW_OUTPUT_BYTE_LIMIT)
      const { status, summary } = summaryFor(input.kind, result.exitCode, combined)

      yield* recordComplete({ id, status, durationMs: result.durationMs, summary, rawOutput })

      return {
        kind: input.kind,
        target: input.target,
        status,
        summary,
        durationMs: result.durationMs,
        cacheHit: false,
        rawOutput,
        command: description,
      }
    }).pipe(Effect.catchCause(() => Effect.succeed(erroredResult(input.kind, input.target, describeCommand(input.command)))))

  const typecheck = (input: TypecheckInput): Effect.Effect<VerifierResult> =>
    Effect.gen(function* () {
      const projectRoot = resolveProjectRoot(input)
      if (!withinProject(projectRoot, input.path)) {
        return erroredResult("typecheck", input.path ?? projectRoot, "", `typecheck: path escapes projectRoot`)
      }
      const info = yield* detectProject(projectRoot)
      const loaded = yield* options.config.get()
      const command = resolveTypecheckCommand(info, loaded.config.commands?.typecheck)
      const target = input.path !== undefined ? path.resolve(projectRoot, input.path) : projectRoot
      return yield* execute({
        kind: "typecheck",
        target,
        projectRoot,
        command,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS.typecheck,
      })
    })

  const test = (input: TestInput): Effect.Effect<VerifierResult> =>
    Effect.gen(function* () {
      const projectRoot = resolveProjectRoot(input)
      if (!withinProject(projectRoot, input.path)) {
        return erroredResult("test", input.path, "", `test: path escapes projectRoot`)
      }
      const resolvedPath = path.resolve(projectRoot, input.path)
      const info = yield* detectProject(projectRoot)
      const loaded = yield* options.config.get()
      const command = resolveTestCommand(info, input, resolvedPath, loaded.config.commands?.test)
      return yield* execute({
        kind: "test",
        target: resolvedPath,
        projectRoot,
        command,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS.test,
      })
    })

  const lint = (input: LintInput): Effect.Effect<VerifierResult> =>
    Effect.gen(function* () {
      const projectRoot = resolveProjectRoot(input)
      if (!withinProject(projectRoot, input.path)) {
        return erroredResult("lint", input.path ?? projectRoot, "", `lint: path escapes projectRoot`)
      }
      const info = yield* detectProject(projectRoot)
      const loaded = yield* options.config.get()
      const command = resolveLintCommand(info, loaded.config.commands?.lint)
      const target = input.path !== undefined ? path.resolve(projectRoot, input.path) : projectRoot
      return yield* execute({
        kind: "lint",
        target,
        projectRoot,
        command,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS.lint,
      })
    })

  const compile = (input: CompileInput): Effect.Effect<VerifierResult> =>
    Effect.gen(function* () {
      const projectRoot = resolveProjectRoot(input)
      if (!withinProject(projectRoot, input.path)) {
        return erroredResult("compile", input.path, "", `compile: path escapes projectRoot`)
      }
      const resolvedPath = path.resolve(projectRoot, input.path)
      const info = yield* detectProject(projectRoot)
      const loaded = yield* options.config.get()
      const command = resolveCompileCommand(info, resolvedPath, loaded.config.commands?.compile)
      return yield* execute({
        kind: "compile",
        target: resolvedPath,
        projectRoot,
        command,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS.compile,
      })
    })

  return { detect: detectProject, typecheck, test, lint, compile }
}

const erroredResult = (
  kind: VerificationKind,
  target: string,
  command: string,
  rawOutput?: string,
): VerifierResult => ({
  kind,
  target,
  status: "errored",
  summary: {},
  durationMs: 0,
  cacheHit: false,
  rawOutput: rawOutput !== undefined ? rawOutput : undefined,
  command,
})

import type { Argv } from "yargs"
import path from "path"
import { createHash } from "crypto"
import { existsSync } from "fs"
import { Duration, Effect, Option, Stream } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { State, type Interface as CodegraphBuildServiceInterface } from "@opencode-ai/core/banyancode/codegraph-build-service"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { readTrace, type TraceEvent } from "@opencode-ai/core/observability/trace"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

const dim = (value: string) => UI.Style.TEXT_DIM + value + UI.Style.TEXT_NORMAL

const formatState = (state: State) => {
  const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0
  const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5))
  const file = state.currentFile ? dim("  " + state.currentFile) : ""
  const result = state.result
    ? dim(
        `  (indexed ${state.result.indexed}, skipped ${state.result.skipped}, ${(state.result.duration_ms / 1000).toFixed(1)}s)`,
      )
    : ""
  const err = state.error ? `  ${UI.Style.TEXT_DANGER}error: ${state.error}${UI.Style.TEXT_NORMAL}` : ""
  return `[${bar}] ${state.done}/${state.total}  ${state.status}${file}${result}${err}`
}

const printTerminal = (state: State) =>
  Effect.sync(() => {
    if (state.status === "completed") {
      const r = state.result
      UI.println(
        UI.Style.TEXT_SUCCESS +
          `✓ codegraph built (indexed ${r?.indexed ?? 0}, skipped ${r?.skipped ?? 0}, ${((r?.duration_ms ?? 0) / 1000).toFixed(1)}s)` +
          UI.Style.TEXT_NORMAL,
      )
    } else if (state.status === "cancelled") {
      UI.println(UI.Style.TEXT_WARNING + "✗ build cancelled" + UI.Style.TEXT_NORMAL)
    } else if (state.status === "failed") {
      UI.println(UI.Style.TEXT_DANGER + `✗ build failed: ${state.error ?? "unknown"}` + UI.Style.TEXT_NORMAL)
    }
  })

const waitForTerminal = (build: CodegraphBuildServiceInterface, timeoutMs?: number) =>
  Effect.gen(function* () {
    const pollUntil = (deadline: number) =>
      Effect.gen(function* () {
        while (Date.now() < deadline) {
          const s = yield* build.status()
          if (s.status !== "running") return s
          yield* Effect.sleep("500 millis")
        }
        return yield* build.status()
      })
    if (timeoutMs) return yield* pollUntil(Date.now() + timeoutMs)
    while (true) {
      const s = yield* build.status()
      if (s.status !== "running") return s
      yield* Effect.sleep("500 millis")
    }
  })

const streamProgress = (build: CodegraphBuildServiceInterface, timeoutSec: number) =>
  Effect.gen(function* () {
    const events = build.events()
    type ProgressEvent = { type: "banyancode.codegraph.build"; properties: State }
    const stream: Stream.Stream<ProgressEvent, never, never> = Stream.fromQueue(events) as Stream.Stream<
      ProgressEvent,
      never,
      never
    >
    yield* stream.pipe(
      Stream.tap((event: ProgressEvent) =>
        Effect.sync(() => UI.println(formatState(event.properties))),
      ),
      Stream.takeUntil((event: ProgressEvent) => event.properties.status !== "running"),
      Stream.runDrain,
      Effect.race(
        timeoutSec > 0
          ? Effect.sleep(Duration.seconds(timeoutSec)).pipe(
              Effect.andThen(
                Effect.sync(() =>
                  UI.println(
                    UI.Style.TEXT_WARNING +
                      `Timeout after ${timeoutSec}s — build may still be running.` +
                      UI.Style.TEXT_NORMAL,
                  ),
                ),
              ),
            )
          : Effect.never,
      ),
    )
  }).pipe(Effect.ignore)

const BuildCommand = effectCmd({
  command: "build",
  describe: "build the banyancode codegraph for the current workspace",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("root", {
        type: "string",
        describe: "directory to index (defaults to current working directory)",
      })
      .option("force", {
        type: "boolean",
        default: false,
        describe: "rebuild even if the codegraph is already up to date",
      })
      .option("watch", {
        type: "boolean",
        default: false,
        describe: "stream progress events until the build finishes (default: true in TTY)",
      })
      .option("timeout", {
        type: "number",
        default: 0,
        describe: "fail after N seconds; 0 = no timeout",
      }),
  handler: Effect.fn("Cli.codegraph.build")(function* (args: {
    root?: string
    force: boolean
    watch: boolean
    timeout: number
  }) {
    const root = path.resolve(args.root ?? process.cwd())
    const dbPath = Database.path()
    UI.println(UI.Style.TEXT_HIGHLIGHT + "Building codegraph" + UI.Style.TEXT_NORMAL)
    UI.println(dim(`  root:   ${root}`))
    UI.println(dim(`  db:     ${dbPath}`))
    UI.println(dim(`  force:  ${args.force}`))
    UI.println("")

    const buildServiceOpt = yield* Effect.serviceOption(Banyan.CodegraphBuildService)
    if (Option.isNone(buildServiceOpt)) {
      return yield* fail(
        "CodegraphBuildService is not registered in AppRuntime. Is BANYANCODE_ENABLE set to 0?",
      )
    }
    const build: CodegraphBuildServiceInterface = buildServiceOpt.value

    const before = yield* build.status()
    if (before.status === "running") {
      return yield* fail(
        "A codegraph build is already running. Use `opencode codegraph cancel` to stop it first.",
      )
    }

    yield* build.start({ root, force: args.force, dbPath })

    const isTTY = Boolean(process.stdout.isTTY || process.stderr.isTTY)
    const watch = args.watch || isTTY
    if (!watch) {
      const done = yield* waitForTerminal(
        build,
        args.timeout > 0 ? args.timeout * 1000 : undefined,
      )
      yield* printTerminal(done)
      if (done.status === "failed") return yield* fail(done.error ?? "build failed")
      return
    }

    yield* streamProgress(build, args.timeout)
    const final = yield* build.status()
    yield* printTerminal(final)
    if (final.status === "failed") return yield* fail(final.error ?? "build failed")
  }),
})

const StatusCommand = effectCmd({
  command: "status",
  describe: "print the current codegraph build status",
  instance: false,
  handler: Effect.fn("Cli.codegraph.status")(function* () {
    const buildServiceOpt = yield* Effect.serviceOption(Banyan.CodegraphBuildService)
    if (Option.isNone(buildServiceOpt)) {
      return yield* fail("CodegraphBuildService is not registered in AppRuntime.")
    }
    const build: CodegraphBuildServiceInterface = buildServiceOpt.value
    const state = yield* build.status()
    UI.println(formatState(state))
  }),
})

const CancelCommand = effectCmd({
  command: "cancel",
  describe: "cancel an in-flight codegraph build",
  instance: false,
  handler: Effect.fn("Cli.codegraph.cancel")(function* () {
    const buildServiceOpt = yield* Effect.serviceOption(Banyan.CodegraphBuildService)
    if (Option.isNone(buildServiceOpt)) {
      return yield* fail("CodegraphBuildService is not registered in AppRuntime.")
    }
    const build: CodegraphBuildServiceInterface = buildServiceOpt.value
    const before = yield* build.status()
    if (before.status !== "running") {
      UI.println(dim("no build is currently running"))
      return
    }
    yield* build.cancel()
    const after = yield* build.status()
    UI.println(formatState(after))
  }),
})

const RemoveCommand = effectCmd({
  command: "remove",
  describe: "remove the codegraph index (preserves banyancode.db by default; pass --drop-file to also delete the file)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.option("drop-file", {
      type: "boolean",
      default: false,
      describe: "also delete the banyancode.db file (DANGEROUS: shared with sessions and memory)",
    }),
  handler: Effect.fn("Cli.codegraph.remove")(function* (args: { "drop-file": boolean }) {
    const repoOpt = yield* Effect.serviceOption(Banyan.CodegraphRepo)
    if (Option.isNone(repoOpt)) {
      return yield* fail("CodegraphRepo is not registered in AppRuntime.")
    }
    const { sizeBefore, sizeAfter } = yield* repoOpt.value.clearAll({ dropFile: args["drop-file"] })
    if (sizeBefore === 0) {
      UI.println("Codegraph index was already empty.")
      return
    }
    const freedBytes = Math.max(0, sizeBefore - sizeAfter)
    UI.println(
      UI.Style.TEXT_SUCCESS +
        `✓ Codegraph index removed. Freed ${freedBytes} bytes (${sizeBefore} -> ${sizeAfter}).` +
        UI.Style.TEXT_NORMAL,
    )
  }),
})

const ForceKillCommand = effectCmd({
  command: "force-kill",
  describe: "force-kill a stuck codegraph build (Fiber.interrupt + taskkill fallback)",
  instance: false,
  handler: Effect.fn("Cli.codegraph.forceKill")(function* () {
    const buildServiceOpt = yield* Effect.serviceOption(Banyan.CodegraphBuildService)
    if (Option.isNone(buildServiceOpt)) {
      return yield* fail("CodegraphBuildService is not registered in AppRuntime.")
    }
    const build: CodegraphBuildServiceInterface = buildServiceOpt.value
    const result = yield* build.forceKill()
    if (result.ok) UI.println(UI.Style.TEXT_SUCCESS + "✓ " + result.message + UI.Style.TEXT_NORMAL)
    else UI.println(UI.Style.TEXT_DANGER + "✗ " + result.message + UI.Style.TEXT_NORMAL)
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the banyancode database path",
  instance: false,
  handler: Effect.fn("Cli.codegraph.path")(function* () {
    UI.println(Database.path())
  }),
})

const TRACE_COLUMN_TS = 15
const TRACE_COLUMN_TOOL = 28
const TRACE_COLUMN_INPUT = 30
const TRACE_COLUMN_RESULT = 30
const TRACE_COLUMN_MS = 6

const truncate = (value: string, width: number) =>
  value.length <= width ? value.padEnd(width) : value.slice(0, Math.max(0, width - 1)) + "…"

const summarizeInput = (input: unknown): string => {
  if (input === undefined || input === null) return ""
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

const findTraceFile = (worktree: string, sessionID: string): string | undefined => {
  const candidates = [
    path.join(worktree, ".banyancode", "trace", `${sessionID}.jsonl`),
    path.join(
      Global.Path.banyan.data,
      "trace",
      createHash("sha256").update(worktree).digest("hex").slice(0, 16),
      `${sessionID}.jsonl`,
    ),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
}

const printTraceRow = (event: TraceEvent) => {
  const inputText = event.phase === "start" ? summarizeInput(event.input) : ""
  const resultText = event.phase === "end" ? (event.resultSummary ?? "") : ""
  const msText = event.phase === "end" && typeof event.ms === "number" ? String(event.ms) : ""
  const tsText = String(event.ts)
  const toolText = event.tool
  UI.println(
    UI.Style.TEXT_DIM + truncate(tsText, TRACE_COLUMN_TS) + UI.Style.TEXT_NORMAL,
    UI.Style.TEXT_INFO_BOLD + truncate(toolText, TRACE_COLUMN_TOOL) + UI.Style.TEXT_NORMAL,
    UI.Style.TEXT_NORMAL + truncate(inputText, TRACE_COLUMN_INPUT) + UI.Style.TEXT_NORMAL,
    truncate(resultText, TRACE_COLUMN_RESULT),
    UI.Style.TEXT_DIM + truncate(msText, TRACE_COLUMN_MS) + UI.Style.TEXT_NORMAL,
  )
}

const printTraceHeader = () => {
  const header = [
    "TIME",
    "TOOL",
    "INPUT-SUMMARY",
    "RESULT-SUMMARY",
    "MS",
  ]
  UI.println(
    UI.Style.TEXT_DIM +
      [
        truncate(header[0], TRACE_COLUMN_TS),
        truncate(header[1], TRACE_COLUMN_TOOL),
        truncate(header[2], TRACE_COLUMN_INPUT),
        truncate(header[3], TRACE_COLUMN_RESULT),
        truncate(header[4], TRACE_COLUMN_MS),
      ].join(" ") +
      UI.Style.TEXT_NORMAL,
  )
}

const TraceCommand = effectCmd({
  command: "trace",
  describe: "print recent tool-call traces for a session",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("session", {
        type: "string",
        demandOption: true,
        describe: "session id whose trace file should be read",
      })
      .option("limit", {
        type: "number",
        default: 50,
        describe: "number of most-recent events to print (default: 50)",
      })
      .option("worktree", {
        type: "string",
        describe: "project worktree to locate the trace file (defaults to current directory)",
      }),
  handler: Effect.fn("Cli.codegraph.trace")(function* (args: {
    session: string
    limit: number
    worktree?: string
  }) {
    const worktree = path.resolve(args.worktree ?? process.cwd())
    const file = findTraceFile(worktree, args.session)
    if (!file || !existsSync(file)) {
      UI.println(`no traces for session ${args.session}`)
      return
    }
    const events = yield* Effect.promise(() => readTrace(worktree, args.session))
    const tail = events.slice(-Math.max(1, args.limit))
    UI.println(UI.Style.TEXT_HIGHLIGHT + `Trace for session ${args.session}` + UI.Style.TEXT_NORMAL)
    UI.println(dim(`  file:   ${file}`))
    UI.println(dim(`  events: ${events.length} (showing last ${tail.length})`))
    UI.println("")
    printTraceHeader()
    for (let i = tail.length - 1; i >= 0; i--) {
      const event = tail[i]
      if (event) printTraceRow(event)
    }
  }),
})

export const CodegraphCommand = effectCmd({
  command: "codegraph",
  describe: "build and inspect the banyancode codegraph",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .command(BuildCommand)
      .command(StatusCommand)
      .command(CancelCommand)
      .command(RemoveCommand)
      .command(ForceKillCommand)
      .command(PathCommand)
      .command(TraceCommand)
      .demandCommand(),
  handler: Effect.fn("Cli.codegraph")(function* () {}),
})

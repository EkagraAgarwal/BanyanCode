export * as CodegraphChildIndexer from "./codegraph-indexer-child"

import { Effect, Layer, Logger } from "effect"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Database } from "../database/database"
import { FSUtil } from "../fs-util"
import { CodegraphIndexer } from "./codegraph-indexer"
import { CodegraphRepo } from "./codegraph-repo"

/**
 * Child-process codegraph indexer.
 *
 * The TUI worker (which also serves session/SSE RPCs) used to run the full
 * index — walk, parse, SQLite write, derived pass — on its single event
 * loop. A large repo froze the loop for minutes and the UI became
 * unresponsive to prompt/SSE, Esc, and Ctrl+C. This module moves that work
 * into a dedicated child process:
 *
 * - The parent (CodegraphBuildService) owns DB identity (derives the
 *   canonical `.banyancode` DB path) and cancellation (kills the child).
 * - The child owns walk/parse/write/derived against that DB, streaming
 *   progress/result lines over stdout as JSON.
 * - Cancelling is a hard guarantee: the parent `proc.kill()`s the child
 *   (TerminateProcess on Windows), so a CPU-bound parse loop can never
 *   wedge the interactive worker.
 *
 * Spawn strategy:
 * - Source/dev/test runs: `bun <this-file> --child-config=<json>` (the file
 *   exists on disk, so `childCommand` resolves to the bun runtime).
 * - Compiled binaries: `childCommand` falls back to re-exec'ing the binary
 *   with `--codegraph-indexer-child`, which `packages/opencode/src/index.ts`
 *   intercepts before yargs and dispatches here. The child module is bundled
 *   into the binary, so the same code path runs in both contexts.
 *
 * Protocol (one JSON object per stdout line):
 * - { type: "progress", file, done, total, currentFile }
 * - { type: "phase", phase: "derived" }
 * - { type: "result", result, graphVersion, coverage, totalNodes,
 *     totalEdges, totalFiles, graphBuiltAt }
 * - { type: "error", message }
 */

export const CODEGRAPH_CHILD_FLAG = "--codegraph-indexer-child"
const CONFIG_PREFIX = "--child-config="

export interface ChildIndexerConfig {
  root: string
  dbPath: string
  force?: boolean
  excludePatterns?: readonly string[]
}

/** True when the TUI worker opted into child-process indexing. */
export const childIndexerEnabled = (): boolean => process.env.BANYANCODE_INDEXER_CHILD === "1"

const childScriptPath = (): string =>
  fileURLToPath(new URL("./codegraph-indexer-child.ts", import.meta.url))

/**
 * Resolve the spawn command for the child. When the source module exists on
 * disk (dev / tests) run it with the bun runtime; in a compiled binary the
 * module is virtual, so re-exec the current executable (which `Bun.execPath()`
 * reports even for compiled binaries) and let the CLI entry dispatch on
 * `CODEGRAPH_CHILD_FLAG`.
 */
export const childCommand = (config: ChildIndexerConfig): string[] => {
  const configArg = `${CONFIG_PREFIX}${JSON.stringify(config)}`
  if (existsSync(childScriptPath())) {
    return [process.execPath, childScriptPath(), configArg]
  }
  return [process.execPath, CODEGRAPH_CHILD_FLAG, configArg]
}

const writeLine = (obj: unknown) => {
  process.stdout.write(JSON.stringify(obj) + "\n")
}

/**
 * Entry point used both by `import.meta.main` (spawned via bun) and by the
 * compiled CLI's `--codegraph-indexer-child` dispatch. Runs the real indexer
 * against the canonical DB path, streams progress, runs `bumpVersion`, and
 * exits 0 on success / 1 on failure. Never throws across the process boundary
 * — failures are reported as an `error` message line.
 */
export const runChildIndexer = async (configJson: string): Promise<number> => {
  let config: ChildIndexerConfig
  try {
    config = JSON.parse(configJson) as ChildIndexerConfig
  } catch {
    writeLine({ type: "error", message: `invalid --child-config: ${configJson.slice(0, 200)}` })
    return 2
  }
  if (!config.root || !config.dbPath) {
    writeLine({ type: "error", message: "child indexer: root and dbPath are required" })
    return 2
  }

  const dbLayer = Database.layerFromPath(config.dbPath)
  const layer = CodegraphIndexer.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provideMerge(CodegraphRepo.layer.pipe(Layer.provide(dbLayer))),
    Layer.provide(dbLayer),
  )

  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service
        const result = yield* indexer.index({
          root: config.root,
          force: config.force ?? false,
          ...(config.excludePatterns && config.excludePatterns.length > 0
            ? { excludePatterns: config.excludePatterns }
            : {}),
          onProgress: Effect.fn("CodegraphChildIndexer.onProgress")(function* ({ file, done, total, currentFile, phase }) {
            if (phase === "derived") {
              writeLine({ type: "phase", phase: "derived" })
              return
            }
            writeLine({ type: "progress", file, done, total, currentFile })
          }),
        })
        const bump = yield* repo.bumpVersion({
          eligibleFiles: result.eligibleFiles,
          scannedFiles: result.scannedFiles,
          indexedRoot: config.root,
        })
        writeLine({ type: "result", result, ...bump })
        return 0
      }).pipe(
        Effect.provide(layer),
        // The child's stdout is the IPC channel — effect log lines must not
        // interleave with the JSON protocol.
        Effect.provide(Logger.layer([Logger.make(() => {})], { mergeWithExisting: false })),
      ),
    )
  } catch (error) {
    writeLine({ type: "error", message: error instanceof Error ? error.message : String(error) })
    return 1
  }
}

const configFromArgv = (argv: readonly string[]): string | undefined => {
  const arg = argv.find((a) => a.startsWith(CONFIG_PREFIX))
  return arg?.slice(CONFIG_PREFIX.length)
}

if (import.meta.main) {
  const configJson = configFromArgv(process.argv)
  if (!configJson) {
    writeLine({ type: "error", message: "child indexer: missing --child-config=<json>" })
    process.exit(2)
  }
  runChildIndexer(configJson).then((code) => process.exit(code))
}

/**
 * `codegraph` — index lifecycle, status and drift for the code graph.
 *
 * One id replaces the three per-operation graph tools (build, remove,
 * staleness); `op` selects the operation. Each op still calls the service
 * function the old tool called and renders the same model-facing text.
 * `build` and `remove` change state, so the tool carries the `codegraph`
 * permission action (the plan agent asks for it).
 */
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { existsSync } from "node:fs"
import path from "node:path"
import type { Interface as CodegraphAutoUpdateInterface } from "../codegraph-auto-update.js"
import { State as BuildState } from "../codegraph-build-service.js"
import type { Interface as CodegraphBuildServiceInterface } from "../codegraph-build-service.js"
import type { Interface as CodegraphReadinessInterface } from "../codegraph-readiness.js"
import { ReadinessResult } from "../codegraph-readiness.js"
import type { Interface as CodegraphRepoInterface } from "../codegraph-repo.js"
import { GraphMeta } from "../types.js"
import { resolveProjectRoot } from "../workspace-identity.js"
import { optionalBoolean, optionalString } from "./schema.js"

export const name = "codegraph"

export interface Deps {
  readonly repo: CodegraphRepoInterface
  readonly buildService: CodegraphBuildServiceInterface
  readonly readiness: CodegraphReadinessInterface
  readonly autoUpdate: CodegraphAutoUpdateInterface
  /** The open project's root; every op default resolves here, never the host cwd. */
  readonly projectRoot: () => string
  /** `banyancode_codegraph_exclude_patterns`, applied to an explicit build. */
  readonly excludePatterns?: () => Effect.Effect<readonly string[], never, never>
  readonly databasePath?: () => string
  readonly schemaVersion?: () => number
}

export const Input = Schema.Struct({
  op: Schema.Literals(["status", "build", "remove", "staleness"]).annotate({
    description:
      "status reads build/readiness/watcher state; build indexes the workspace (force rebuids from scratch); remove clears the index; staleness reports drift from the working tree.",
  }),
  root: optionalString.annotate({
    description: "Workspace root. Defaults to the open project's root; a path outside it is refused (build) or ignored (staleness).",
  }),
  force: optionalBoolean.annotate({ description: "Wipe the existing index before rebuilding (build). Defaults to false." }),
  dropFile: optionalBoolean.annotate({
    description: "Clear every table, VACUUM and truncate the WAL (remove). The database file itself is kept.",
  }),
})

const BuildOutput = Schema.Struct({
  indexed: Schema.Number,
  skipped: Schema.Number,
  duration_ms: Schema.Number,
  symbolsIndexed: Schema.Number,
  skippedByReason: Schema.Struct({
    gitignored: Schema.Number,
    banyanignored: Schema.Number,
    artifact: Schema.Number,
    tooLarge: Schema.Number,
    minified: Schema.Number,
    tooLargeParse: Schema.Number,
    cached: Schema.Number,
    readError: Schema.Number,
    parseFailure: Schema.Number,
  }),
  parseErrors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        cause: Schema.String,
        indexedAt: Schema.Number,
      }),
    ),
  ),
  meta: Schema.optional(GraphMeta),
})

const RemoveOutput = Schema.Struct({
  status: Schema.Literals(["removed", "empty"]),
  sizeBefore: Schema.Number,
  sizeAfter: Schema.Number,
  freedBytes: Schema.Number,
  droppedFile: Schema.Boolean,
})

const StalenessOutput = Schema.Struct({
  staleFiles: Schema.Int,
  missingFiles: Schema.Int,
  totalFiles: Schema.Int,
  topStale: Schema.Array(Schema.Struct({ path: Schema.String, mtimeMs: Schema.Number, indexedAt: Schema.Number })),
  topMissing: Schema.Array(Schema.Struct({ path: Schema.String, indexedAt: Schema.Number })),
})

const StatusOutput = Schema.Struct({
  build: BuildState,
  readiness: ReadinessResult,
  autoUpdate: Schema.Struct({
    status: Schema.Literals(["idle", "watching", "draining", "paused"]),
    pending: Schema.Number,
    lastChangeAt: Schema.optional(Schema.Number),
  }),
  meta: Schema.optional(GraphMeta),
  databasePath: Schema.optional(Schema.String),
  schemaVersion: Schema.optional(Schema.Number),
})

export const Output = Schema.Struct({
  op: Schema.String,
  build: Schema.optional(BuildOutput),
  remove: Schema.optional(RemoveOutput),
  staleness: Schema.optional(StalenessOutput),
  status: Schema.optional(StatusOutput),
})

type OutputType = typeof Output.Type

const metaOrUndefined = (meta: {
  graphBuiltAt: number
  graphVersion: number
  graphCoverage: number
  totalFiles: number
  totalNodes: number
  totalEdges: number
} | undefined) =>
  meta
    ? {
        graphBuiltAt: meta.graphBuiltAt,
        graphVersion: meta.graphVersion,
        graphCoverage: meta.graphCoverage,
        totalFiles: meta.totalFiles,
        totalNodes: meta.totalNodes,
        totalEdges: meta.totalEdges,
      }
    : undefined

const renderBuild = (output: NonNullable<OutputType["build"]>): string => {
  const r = output.skippedByReason
  const lines = [
    `indexed=${output.indexed} skipped=${output.skipped}`,
    `skippedByReason.gitignored=${r.gitignored} banyanignored=${r.banyanignored} artifact=${r.artifact}`,
    `skippedByReason.tooLarge=${r.tooLarge} minified=${r.minified} tooLargeParse=${r.tooLargeParse}`,
    `skippedByReason.cached=${r.cached} readError=${r.readError} parseFailure=${r.parseFailure}`,
    `parseErrors.length=${output.parseErrors?.length ?? 0}`,
    `symbolsIndexed=${output.symbolsIndexed} duration_ms=${output.duration_ms}`,
  ]
  if (output.meta) {
    const m = output.meta
    lines.push(
      `meta.graphVersion=${m.graphVersion} meta.graphCoverage=${m.graphCoverage?.toFixed(4) ?? "n/a"} meta.totalFiles=${m.totalFiles} meta.totalNodes=${m.totalNodes} meta.totalEdges=${m.totalEdges}`,
    )
  }
  return lines.join("\n")
}

const renderStaleness = (output: NonNullable<OutputType["staleness"]>): string => {
  const staleLines = output.topStale.map((file) => `  ${file.path}  mtime=${file.mtimeMs} indexedAt=${file.indexedAt}`).join("\n")
  const missingLines = output.topMissing.map((file) => `  ${file.path}  indexedAt=${file.indexedAt}`).join("\n")
  return [
    `staleFiles=${output.staleFiles} missingFiles=${output.missingFiles} totalFiles=${output.totalFiles} (${output.totalFiles === 0 ? "no graph indexed" : `${Math.round(((output.staleFiles + output.missingFiles) / output.totalFiles) * 100)}% drift`})`,
    output.topStale.length > 0 ? `Top stale files:\n${staleLines}` : "Top stale files: none.",
    output.topMissing.length > 0
      ? `Top missing files (indexed but deleted from disk):\n${missingLines}`
      : "Top missing files: none.",
  ].join("\n")
}

const renderStatus = (output: NonNullable<OutputType["status"]>): string => {
  const lines = [
    `build=${output.build.status} readiness=${output.readiness.reason} watcher=${output.autoUpdate.status} pending=${output.autoUpdate.pending}`,
  ]
  if (output.build.done !== undefined && output.build.total !== undefined)
    lines.push(`progress=${output.build.done}/${output.build.total}${output.build.currentFile ? ` current=${output.build.currentFile}` : ""}`)
  if (output.readiness.warning) lines.push(`warning=${output.readiness.warning}`)
  if (output.readiness.error) lines.push(`error=${output.readiness.error}`)
  if (output.meta)
    lines.push(
      `meta.graphVersion=${output.meta.graphVersion} meta.graphCoverage=${output.meta.graphCoverage?.toFixed(4) ?? "n/a"} meta.totalFiles=${output.meta.totalFiles} meta.totalNodes=${output.meta.totalNodes}`,
    )
  if (output.databasePath) lines.push(`databasePath=${output.databasePath}`)
  if (output.schemaVersion !== undefined) lines.push(`schemaVersion=${output.schemaVersion}`)
  return lines.join("\n")
}

export const tool = (deps: Deps): Tool.Info<typeof Input, typeof Output> => ({
  name,
  description:
    "Code graph index lifecycle. op=status (build/readiness/watcher state), build (index the workspace; force re-indexes from scratch), remove (clear the index, keep the database file), staleness (drift from the working tree). build and remove change state.",
  input: Input,
  output: Output,
  options: { permission: name, codemode: true },
  execute: (input) =>
    Effect.gen(function* () {
      const configuredRoot = (requested?: string) => resolveProjectRoot(deps.projectRoot(), requested)

      if (input.op === "status") {
        const [build, readiness, autoUpdate, meta] = yield* Effect.all([
          deps.buildService.status(),
          deps.readiness.status(),
          deps.autoUpdate.state(),
          deps.repo.getMeta(),
        ])
        const status = {
          build,
          readiness,
          autoUpdate,
          ...(meta ? { meta } : {}),
          ...(deps.databasePath ? { databasePath: deps.databasePath() } : {}),
          ...(deps.schemaVersion ? { schemaVersion: deps.schemaVersion() } : {}),
        }
        return { output: { op: input.op, status } as OutputType, content: renderStatus(status) }
      }

      if (input.op === "staleness") {
        const resolution = configuredRoot(input.root)
        const root = resolution._tag === "Ok" ? resolution.root : deps.projectRoot()
        const totalFiles = yield* deps.repo.countFiles()
        if (totalFiles === 0) {
          const output = { staleFiles: 0, missingFiles: 0, totalFiles: 0, topStale: [], topMissing: [] }
          return { output: { op: input.op, staleness: output }, content: renderStaleness(output) }
        }
        const staleFiles = yield* deps.repo.countStaleFiles()
        const topStale = yield* deps.repo.listStaleFiles(10)
        const all = yield* deps.repo.listAllFiles()
        const missing = all
          .filter((file) => {
            const candidate = path.isAbsolute(file.path) ? file.path : path.join(root, file.path)
            return !existsSync(candidate)
          })
          .map((file) => ({ path: file.path, indexedAt: file.indexedAt }))
        const output = {
          staleFiles,
          missingFiles: missing.length,
          totalFiles,
          topStale: [...topStale],
          topMissing: missing.slice(0, 10),
        }
        return { output: { op: input.op, staleness: output }, content: renderStaleness(output) }
      }

      const resolution = configuredRoot(input.root)
      if (input.op === "build") {
        if (resolution._tag === "Refused") {
          return yield* Effect.fail(new Tool.Error({ message: `codegraph build: ${resolution.message}` }))
        }
        const configured = deps.excludePatterns ? yield* deps.excludePatterns() : []
        yield* deps.buildService.start({
          root: resolution.root,
          force: input.force ?? false,
          ...(configured.length > 0 ? { excludePatterns: configured } : {}),
        })

        let currentStatus = yield* deps.buildService.status()
        while (currentStatus.status === "running") {
          yield* Effect.sleep("500 millis")
          currentStatus = yield* deps.buildService.status()
        }

        if (currentStatus.status === "failed") {
          return yield* Effect.fail(
            new Tool.Error({ message: `codegraph build failed: ${currentStatus.error ?? "unknown error"}` }),
          )
        }
        if (currentStatus.status === "cancelled") {
          return yield* Effect.fail(new Tool.Error({ message: "codegraph build was cancelled" }))
        }

        const empty = {
          indexed: 0,
          skipped: 0,
          duration_ms: 0,
          symbolsIndexed: 0,
          skippedByReason: {
            gitignored: 0,
            banyanignored: 0,
            artifact: 0,
            tooLarge: 0,
            minified: 0,
            tooLargeParse: 0,
            cached: 0,
            readError: 0,
            parseFailure: 0,
          },
          parseErrors: [] as Array<{ path: string; cause: string; indexedAt: number }>,
          meta: undefined,
        }

        if (currentStatus.status !== "completed" || !currentStatus.result) {
          return { output: { op: input.op, build: empty } as OutputType, content: renderBuild(empty) }
        }

        const meta = yield* deps.repo.getMeta()
        const r = currentStatus.result
        const output = {
          indexed: r.indexed,
          skipped: r.skipped,
          duration_ms: r.duration_ms,
          symbolsIndexed: r.symbolsIndexed,
          skippedByReason: r.skippedByReason,
          parseErrors: currentStatus.parseErrors ?? [],
          meta: metaOrUndefined(meta),
        }
        return { output: { op: input.op, build: output } as OutputType, content: renderBuild(output) }
      }

      // op=remove: stop a running build first so it cannot write rows into the
      // tables being cleared, then wipe and reset the last-run state.
      yield* deps.buildService.cancel()
      const [filesBefore, nodesBefore, edgesBefore] = yield* Effect.all([
        deps.repo.countFiles(),
        deps.repo.countNodes(),
        deps.repo.countEdges(),
      ])
      const graphWasEmpty = filesBefore === 0 && nodesBefore === 0 && edgesBefore === 0
      const { sizeBefore, sizeAfter, droppedFile } = yield* deps.repo.clearAll({
        dropFile: input.dropFile ?? false,
      })
      yield* deps.buildService.reset()
      const freedBytes = Math.max(0, sizeBefore - sizeAfter)
      const output = {
        status: (graphWasEmpty ? "empty" : "removed") as "empty" | "removed",
        sizeBefore,
        sizeAfter,
        freedBytes,
        droppedFile,
      }
      const cleared =
        input.dropFile && !droppedFile
          ? " The database file is kept (the plugin holds it open) and now contains an empty schema; a build writes into it again."
          : ""
      const content =
        output.status === "empty"
          ? "Codegraph index was already empty."
          : `Codegraph index removed. Freed ${output.freedBytes} bytes (${output.sizeBefore} -> ${output.sizeAfter}).${cleared}`
      return { output: { op: input.op, remove: output } as OutputType, content }
    }),
})

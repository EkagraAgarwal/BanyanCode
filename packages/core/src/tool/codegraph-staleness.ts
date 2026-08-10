export * as CodegraphStalenessTool from "./codegraph-staleness"

import { Effect, Layer, Schema } from "effect"
import { existsSync } from "node:fs"
import path from "path"
import { Banyan } from "../banyancode"
import { traced } from "../observability/trace"
import type { Interface as CodegraphRepoInterface } from "../banyancode/codegraph-repo"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "codegraph_staleness"

const PathField = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9 _./-]+$/))

export const Input = Schema.Struct({
  root: Schema.optional(PathField.annotate({
    description: "Optional absolute or `./`-relative workspace root. Defaults to the caller's cwd.",
  })),
}).annotate({
  description:
    "Report code graph drift from the working tree: how many indexed files " +
    "changed on disk after they were indexed (`mtime_ms > indexed_at`) and how " +
    "many indexed files were DELETED from disk (`missingFiles` — ghost rows the " +
    "next build will prune). A nonzero stale or missing count means the graph " +
    "is drifting and a rebuild is worth considering.",
})

const StaleFileSchema = Schema.Struct({
  path: Schema.String,
  mtimeMs: Schema.Number,
  indexedAt: Schema.Number,
})

const MissingFileSchema = Schema.Struct({
  path: Schema.String,
  indexedAt: Schema.Number,
})

export const Output = Schema.Struct({
  staleFiles: Schema.Int,
  missingFiles: Schema.Int,
  totalFiles: Schema.Int,
  topStale: Schema.Array(StaleFileSchema),
  topMissing: Schema.Array(MissingFileSchema),
})

const renderOutput = (output: Schema.Schema.Type<typeof Output>): string => {
  const staleLines = output.topStale
    .map((file) => `  ${file.path}  mtime=${file.mtimeMs} indexedAt=${file.indexedAt}`)
    .join("\n")
  const missingLines = output.topMissing
    .map((file) => `  ${file.path}  indexedAt=${file.indexedAt}`)
    .join("\n")
  return [
    `staleFiles=${output.staleFiles} missingFiles=${output.missingFiles} totalFiles=${output.totalFiles} (${output.totalFiles === 0 ? "no graph indexed" : `${Math.round(((output.staleFiles + output.missingFiles) / output.totalFiles) * 100)}% drift`})`,
    output.topStale.length > 0
      ? `Top stale files:\n${staleLines}`
      : "Top stale files: none.",
    output.topMissing.length > 0
      ? `Top missing files (indexed but deleted from disk):\n${missingLines}`
      : "Top missing files: none.",
  ].join("\n")
}

export const makeCodegraphStalenessTool = (deps: {
  readonly permission: PermissionV2.Interface
  readonly repo: CodegraphRepoInterface
}) =>
  Tool.make({
    description:
      "Use when:\n" +
      "  you need to know whether the code graph is drifting from the working " +
      "  tree. Counts indexed files whose mtime is newer than their indexed_at " +
      "  (content changed on disk after the snapshot) and indexed files that no " +
      "  longer exist on disk (`missingFiles` — ghost rows the next build will " +
      "  prune). Lists the most recently changed stale files and the top missing.\n" +
      "Examples\n" +
      "  - \"Is the graph stale?\"\n" +
      "  - \"Which files changed since they were indexed?\"\n" +
      "  - \"Are there deleted files still in the index?\"\n" +
      "Returns\n" +
      "  { staleFiles, missingFiles, totalFiles, topStale: [{ path, mtimeMs, indexedAt }], topMissing: [{ path, indexedAt }] }\n" +
      "Avoid when\n" +
      "  you need symbol-level lookup — use code_find / repository_query.\n" +
      "Note\n" +
      "  Read-only diagnostic. Returns zeros when no graph is indexed.",
    contract: { visibility: "public" },
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [{ type: "text", text: renderOutput(output) }],
    execute: (input, context) => {
      const root = input.root ? path.resolve(input.root) : process.cwd()
      return traced(
        root,
        context.sessionID,
        name,
        input,
        (output) => `staleFiles=${output.staleFiles} missingFiles=${output.missingFiles} totalFiles=${output.totalFiles}`,
        Effect.gen(function* () {
          yield* deps.permission.assert({
            action: name,
            resources: [root],
            save: ["*"],
            metadata: { root },
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
          }).pipe(Effect.orDie)

          const totalFiles = yield* deps.repo.countFiles()
          if (totalFiles === 0) {
            return { staleFiles: 0, missingFiles: 0, totalFiles: 0, topStale: [], topMissing: [] }
          }
          const staleFiles = yield* deps.repo.countStaleFiles()
          const topStale = yield* deps.repo.listStaleFiles(10)
          const all = yield* deps.repo.listAllFiles()
          const missing: { path: string; indexedAt: number }[] = []
          for (const file of all) {
            const candidate = path.isAbsolute(file.path) ? file.path : path.join(root, file.path)
            if (!existsSync(candidate)) missing.push({ path: file.path, indexedAt: file.indexedAt })
          }
          return {
            staleFiles,
            missingFiles: missing.length,
            totalFiles,
            topStale: [...topStale],
            topMissing: missing.slice(0, 10),
          }
        }),
      )
    },
  })

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const repo = yield* Banyan.CodegraphRepo

    yield* tools.register({
      [name]: makeCodegraphStalenessTool({
        permission,
        repo: repo as unknown as Parameters<typeof makeCodegraphStalenessTool>[0]["repo"],
      }),
    })
  }),
)

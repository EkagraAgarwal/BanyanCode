export * as CodegraphStalenessTool from "./codegraph-staleness"

import { Effect, Layer, Schema } from "effect"
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
    "Report code graph staleness: how many indexed files changed on disk after " +
    "they were indexed (`mtime_ms > indexed_at`), plus the most recently " +
    "modified stale files. A nonzero stale count means the graph is drifting " +
    "from the working tree and a rebuild is worth considering.",
})

const StaleFileSchema = Schema.Struct({
  path: Schema.String,
  mtimeMs: Schema.Number,
  indexedAt: Schema.Number,
})

export const Output = Schema.Struct({
  staleFiles: Schema.Int,
  totalFiles: Schema.Int,
  topStale: Schema.Array(StaleFileSchema),
})

const renderOutput = (output: Schema.Schema.Type<typeof Output>): string => {
  const staleLines = output.topStale
    .map((file) => `  ${file.path}  mtime=${file.mtimeMs} indexedAt=${file.indexedAt}`)
    .join("\n")
  return [
    `staleFiles=${output.staleFiles} totalFiles=${output.totalFiles} (${output.totalFiles === 0 ? "no graph indexed" : `${Math.round((output.staleFiles / output.totalFiles) * 100)}% stale`})`,
    output.topStale.length > 0
      ? `Top stale files:\n${staleLines}`
      : "Top stale files: none.",
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
      "  (content changed on disk after the snapshot) and lists the most " +
      "  recently changed stale files.\n" +
      "Examples\n" +
      "  - \"Is the graph stale?\"\n" +
      "  - \"Which files changed since they were indexed?\"\n" +
      "Returns\n" +
      "  { staleFiles, totalFiles, topStale: [{ path, mtimeMs, indexedAt }] }\n" +
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
        (output) => `staleFiles=${output.staleFiles} totalFiles=${output.totalFiles}`,
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
            return { staleFiles: 0, totalFiles: 0, topStale: [] }
          }
          const staleFiles = yield* deps.repo.countStaleFiles()
          const topStale = yield* deps.repo.listStaleFiles(10)
          return { staleFiles, totalFiles, topStale: [...topStale] }
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

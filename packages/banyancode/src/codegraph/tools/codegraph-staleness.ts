/**
 * `codegraph_staleness` — graph drift diagnostic.
 * Ported from v1 `packages/core/src/tool/codegraph-staleness.ts`.
 */
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { existsSync } from "node:fs"
import path from "path"
import type { Interface as CodegraphRepoInterface } from "../codegraph-repo.js"
import { resolveProjectRoot } from "../workspace-identity.js"

export const name = "codegraph_staleness"

const PathField = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9 _./-]+$/))

export const Input = Schema.Struct({
  root: Schema.optional(
    PathField.annotate({
      description: "Optional absolute or project-relative workspace root. Defaults to the open project's root.",
    }),
  ),
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

const renderOutput = (output: typeof Output.Type): string => {
  const staleLines = output.topStale.map((f) => `  ${f.path}  mtime=${f.mtimeMs} indexedAt=${f.indexedAt}`).join("\n")
  const missingLines = output.topMissing.map((f) => `  ${f.path}  indexedAt=${f.indexedAt}`).join("\n")
  return [
    `staleFiles=${output.staleFiles} missingFiles=${output.missingFiles} totalFiles=${output.totalFiles} (${output.totalFiles === 0 ? "no graph indexed" : `${Math.round(((output.staleFiles + output.missingFiles) / output.totalFiles) * 100)}% drift`})`,
    output.topStale.length > 0 ? `Top stale files:\n${staleLines}` : "Top stale files: none.",
    output.topMissing.length > 0
      ? `Top missing files (indexed but deleted from disk):\n${missingLines}`
      : "Top missing files: none.",
  ].join("\n")
}

export interface Deps {
  readonly repo: CodegraphRepoInterface
  readonly projectRoot: () => string
}

export const tool = (deps: Deps): Tool.Info<typeof Input, typeof Output> => ({
  name,
  description:
    "Use when:\n" +
    "  you need to know whether the code graph is drifting from the working " +
    "  tree. Counts indexed files whose mtime is newer than their indexed_at " +
    "  (content changed on disk after the snapshot) and indexed files that no " +
    "  longer exist on disk (`missingFiles` — ghost rows the next build will " +
    "  prune). Lists the most recently changed stale files and the top missing.\n" +
    "Examples\n" +
    '  - "Is the graph stale?"\n' +
    '  - "Which files changed since they were indexed?"\n' +
    '  - "Are there deleted files still in the index?"\n' +
    "Returns\n" +
    "  { staleFiles, missingFiles, totalFiles, topStale: [{ path, mtimeMs, indexedAt }], topMissing: [{ path, indexedAt }] }\n" +
    "Avoid when\n" +
    "  you need symbol-level lookup — use code_find / repository_query.\n" +
    "Note\n" +
    "  Read-only diagnostic. Returns zeros when no graph is indexed.",
  input: Input,
  output: Output,
  options: { permission: name, codemode: true },
  execute: (input) =>
    Effect.gen(function* () {
      const resolution = resolveProjectRoot(deps.projectRoot(), input.root)
      const root = resolution._tag === "Ok" ? resolution.root : deps.projectRoot()
      const totalFiles = yield* deps.repo.countFiles()
      if (totalFiles === 0) {
        const output = { staleFiles: 0, missingFiles: 0, totalFiles: 0, topStale: [], topMissing: [] }
        return { output, content: renderOutput(output) }
      }
      const staleFiles = yield* deps.repo.countStaleFiles()
      const topStale = yield* deps.repo.listStaleFiles(10)
      const all = yield* deps.repo.listAllFiles()
      const missing: { path: string; indexedAt: number }[] = []
      for (const file of all) {
        const candidate = path.isAbsolute(file.path) ? file.path : path.join(root, file.path)
        if (!existsSync(candidate)) missing.push({ path: file.path, indexedAt: file.indexedAt })
      }
      const output = {
        staleFiles,
        missingFiles: missing.length,
        totalFiles,
        topStale: [...topStale] as Array<{ path: string; mtimeMs: number; indexedAt: number }>,
        topMissing: missing.slice(0, 10),
      }
      return { output, content: renderOutput(output) }
    }),
})

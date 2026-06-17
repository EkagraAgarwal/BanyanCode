export * as CodegraphIndexer from "./codegraph-indexer"

import { Context, Effect, Layer, Ref, Schema } from "effect"
import path from "path"
import { createHash } from "crypto"
import ignore from "ignore"
import { FSUtil } from "../fs-util"
import { CodegraphRepo } from "./codegraph-repo"
import type { CodegraphNode } from "./types"
import { getParser } from "./langs/registry"
import type { ParseResult } from "./langs/types"

export class CodegraphError extends Schema.TaggedErrorClass<CodegraphError>()("Banyan/CodegraphError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly index: (input: {
    root: string
    force?: boolean
    onProgress?: (info: { file: string; done: number; total: number }) => Effect.Effect<void>
  }) => Effect.Effect<{ indexed: number; skipped: number }, CodegraphError, never>
  readonly cancel: () => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphIndexer") {}

const DEFAULT_IGNORED = ["node_modules", "dist", "build", "coverage", ".next", ".cache", "target", "vendor"]

const hashContent = (content: string): string => createHash("sha256").update(content).digest("hex")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const repo = yield* CodegraphRepo.Service
    const cancelled = yield* Ref.make(false)

    const walkDirectory = (dir: string): Effect.Effect<string[]> => {
      return Effect.gen(function* () {
        const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.orDie)
        const subDirs = entries.filter((e) => e.type === "directory" && !DEFAULT_IGNORED.includes(path.basename(e.name)))
        const files = entries.filter((e) => e.type === "file").map((e) => path.join(dir, e.name))

        const subFilesList = yield* Effect.forEach(
          subDirs,
          (entry) => walkDirectory(path.join(dir, entry.name)),
          { concurrency: "unbounded" }
        )
        for (const subFiles of subFilesList) {
          files.push(...subFiles)
        }
        return files
      })
    }

    const loadIgnorePatterns = (root: string): Effect.Effect<ReturnType<typeof ignore>> => {
      return Effect.gen(function* () {
        const patterns: string[] = [...DEFAULT_IGNORED.map((d) => d + "/")]
        const gitignorePath = path.join(root, ".gitignore")
        const banyancodeignorePath = path.join(root, ".banyancode", "ignore")
        const gitignoreExists = yield* fs.existsSafe(gitignorePath)
        if (gitignoreExists) {
          const content = yield* fs.readFileStringSafe(gitignorePath).pipe(Effect.orDie)
          if (content) patterns.push(...content.split("\n").filter((l) => l.trim() && !l.startsWith("#")))
        }
        const banyancodeExists = yield* fs.existsSafe(banyancodeignorePath)
        if (banyancodeExists) {
          const content = yield* fs.readFileStringSafe(banyancodeignorePath).pipe(Effect.orDie)
          if (content) patterns.push(...content.split("\n").filter((l) => l.trim() && !l.startsWith("#")))
        }
        return ignore().add(patterns)
      })
    }

    const index = Effect.fn("CodegraphIndexer.index")(function* (input: {
      root: string
      force?: boolean
      onProgress?: (info: { file: string; done: number; total: number }) => Effect.Effect<void>
    }) {
      yield* Ref.set(cancelled, false)

      // Upsert root at start
      const existingRoot = yield* repo.getRoot(input.root)
      const rootID = existingRoot?.id ?? crypto.randomUUID()
      yield* repo.upsertRoot({ id: rootID, rootPath: input.root, parserVersion: "v1" })

      const patterns = yield* loadIgnorePatterns(input.root)
      const allFiles = yield* walkDirectory(input.root).pipe(Effect.orDie)
      const codeFiles = allFiles.filter((f) => {
        const ext = path.extname(f).toLowerCase()
        const relativePath = path.relative(input.root, f).replace(/\\/g, "/")
        return [".ts", ".tsx", ".js", ".jsx", ".py"].includes(ext) && !patterns.ignores(relativePath)
      })

      const indexedRef = yield* Ref.make(0)
      const skippedRef = yield* Ref.make(0)
      const total = codeFiles.length
      const currentRelativePathSet = new Set<string>()

      const chunkSize = 100
      for (let i = 0; i < codeFiles.length; i += chunkSize) {
        const isCancelled = yield* Ref.get(cancelled)
        if (isCancelled) break

        const chunk = codeFiles.slice(i, i + chunkSize)

        const results = yield* Effect.forEach(
          chunk,
          (filePath) =>
            Effect.gen(function* () {
              const relativePath = path.relative(input.root, filePath).replace(/\\/g, "/")

              const ext = path.extname(filePath).toLowerCase()
              const content = yield* fs.readFileStringSafe(filePath).pipe(Effect.orDie)
              if (content === undefined) return { relativePath, indexed: 0, skipped: 0 }

              const contentHash = hashContent(content)
              const existing = yield* repo.getFileByPath(relativePath)
              if (existing && existing.contentHash === contentHash && !input.force) {
                yield* Ref.update(skippedRef, (s) => s + 1)
                return { relativePath, indexed: 0, skipped: 1 }
              }

              const parser = getParser(ext)
              const language = ext === ".py" ? "python" : "typescript"
              const fileID = crypto.randomUUID()

              let result: ParseResult
              try {
                result = yield* Effect.tryPromise({
                  try: () => Promise.race<ParseResult>([
                    new Promise<ParseResult>((resolve) => {
                      resolve(parser.parse(content, fileID, filePath, language))
                    }),
                    new Promise<ParseResult>((_, reject) => setTimeout(() => reject(new Error("Parse timeout")), 5000))
                  ]),
                  catch: (e) => new Error(String(e))
                }).pipe(Effect.orDie)
              } catch (e) {
                 console.error(`[Indexer] Error parsing ${relativePath}: ${e}`)
                 return { relativePath, indexed: 0, skipped: 0 }
              }

              const indexedAt = Date.now()

              const file = {
                id: fileID,
                rootID,
                path: relativePath,
                contentHash,
                byteSize: content.length,
                language,
                indexedAt,
              }

              const nodes = result.nodes.map((node) => ({
                ...node,
                fileID,
                language,
              }))

              const edges = result.edges.map((edge) => ({
                ...edge,
                fileID,
              }))

              return { relativePath, file, nodes, edges, indexed: 1, skipped: 0, deleteFileID: existing?.id }
            }),
          { concurrency: 10 },
        )

        const batchFiles = []
        const batchNodes = []
        const batchEdges = []
        const deleteFileIDs = []

        for (const res of results) {
          currentRelativePathSet.add(res.relativePath)
          if (res.deleteFileID) deleteFileIDs.push(res.deleteFileID)
          if (res.file) batchFiles.push(res.file)
          if (res.nodes) batchNodes.push(...res.nodes)
          if (res.edges) batchEdges.push(...res.edges)
        }

        if (batchFiles.length > 0) {
          for (const id of deleteFileIDs) {
            yield* repo.deleteFile(id)
          }
          for (const f of batchFiles) {
            yield* repo.putFile(f)
          }
          yield* repo.putNodesAndEdgesBatched({ rootID, nodes: batchNodes, edges: batchEdges })

          yield* Ref.update(indexedRef, (idx) => idx + batchFiles.length)
        }

        const done = yield* Ref.get(indexedRef)
        const skipped = yield* Ref.get(skippedRef)
        if (input.onProgress) {
          yield* input.onProgress({ file: chunk[chunk.length - 1], done: done + skipped, total })
        }
      }

      // Clean up stale files (deleted from disk)
      yield* repo.deleteStaleFiles(rootID, currentRelativePathSet)

      // Set root stats at end
      const allNodes = yield* repo.listAllNodes()
      const edgeCount = yield* repo.countAllEdges(rootID)
      const indexed = yield* Ref.get(indexedRef)
      const skipped = yield* Ref.get(skippedRef)

      yield* repo.setRootStats({
        rootID,
        stats: {
          indexedFileCount: indexed,
          nodeCount: allNodes.length,
          edgeCount,
          lastBuildAt: Date.now(),
          embeddingModel: null,
        },
      })

      return { indexed, skipped }
    })

    const cancel = Effect.fn("CodegraphIndexer.cancel")(function* () {
      yield* Ref.set(cancelled, true)
    })

    return Service.of({ index, cancel })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CodegraphRepo.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
)
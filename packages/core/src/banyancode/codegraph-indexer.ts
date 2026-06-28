export * as CodegraphIndexer from "./codegraph-indexer"

import { Cause, Context, Effect, Layer, Ref, Schema } from "effect"
import { randomUUID } from "node:crypto"
import path from "path"
import { FSUtil } from "../fs-util"
import { CodegraphRepo } from "./codegraph-repo"
import type { CodegraphEdge, CodegraphNode } from "./types"
import { getParser } from "./langs/registry"

export class CodegraphError extends Schema.TaggedErrorClass<CodegraphError>()("Banyan/CodegraphError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly index: (input: {
    root: string
    force?: boolean
    maxFileSizeBytes?: number
    onProgress?: (info: { file: string; done: number; total: number }) => Effect.Effect<void>
  }) => Effect.Effect<{ indexed: number; skipped: number; scannedFiles: number }, CodegraphError, never>
  readonly cancel: () => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphIndexer") {}

const DEFAULT_IGNORED = [
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  "target",
  "vendor",
  "out",
  "temp",
  ".sst",
  ".turbo",
  ".drizzle",
  ".git",
  ".opencode",
  ".banyancode",
]

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const repo = yield* CodegraphRepo.Service
    const cancelled = yield* Ref.make(false)

    const walkDirectory = (dir: string, maxFileSizeBytes: number, root: string, patterns: string[]): Effect.Effect<{ files: string[]; skippedBySize: number }> => {
      return Effect.gen(function* () {
        const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.orDie)
        const files: string[] = []
        let skippedBySize = 0
        for (const entry of entries) {
          if (entry.type !== "directory") continue
          const entryName = path.basename(entry.name)
          if (DEFAULT_IGNORED.includes(entryName)) continue
          const fullPath = path.join(dir, entryName)
          if (isIgnored(patterns, root, fullPath)) continue
          const subResult = yield* walkDirectory(fullPath, maxFileSizeBytes, root, patterns)
          files.push(...subResult.files)
          skippedBySize += subResult.skippedBySize
        }
        for (const entry of entries) {
          if (entry.type !== "file") continue
          const fullPath = path.join(dir, entry.name)
          if (isIgnored(patterns, root, fullPath)) continue
          // Skip files larger than maxFileSizeBytes before even reading them
          const stats = yield* fs.stat(fullPath).pipe(Effect.orDie)
          if (stats.size > maxFileSizeBytes) {
            yield* Effect.logWarning(`Skipping file exceeding size limit: ${path.relative(root, fullPath).replace(/\\/g, "/")} (${stats.size} bytes)`)
            skippedBySize++
            continue
          }
          files.push(fullPath)
        }
        return { files, skippedBySize }
      })
    }

    const loadIgnorePatterns = (root: string): Effect.Effect<string[]> => {
      return Effect.gen(function* () {
        const patterns: string[] = [...DEFAULT_IGNORED]
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
        return patterns
      })
    }

    const isIgnored = (patterns: string[], root: string, filePath: string): boolean => {
      const relativePath = path.relative(root, filePath).replace(/\\/g, "/")
      const segments = relativePath.split("/")
      for (const pattern of patterns) {
        const trimmed = pattern.trim()
        if (trimmed === "" || trimmed.startsWith("#")) continue
        const cleanPattern = trimmed.replace(/^\/+|\/+$/g, "")
        if (cleanPattern === "") continue

        if (cleanPattern.includes("/")) {
          if (relativePath === cleanPattern || relativePath.startsWith(cleanPattern + "/")) return true
        } else {
          if (segments.includes(cleanPattern)) return true
          const regex = globToRegex(cleanPattern)
          if (segments.some((seg) => regex.test(seg))) return true
        }
      }
      return false
    }

    const hashContent = (content: string | undefined): string => {
      if (!content) return ""
      let hash = 0
      for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i)
        hash = (hash << 5) - hash + char
        hash = hash & hash
      }
      return Math.abs(hash).toString(16)
    }

    const index = Effect.fn("CodegraphIndexer.index")(function* (input: {
      root: string
      force?: boolean
      maxFileSizeBytes?: number
      onProgress?: (info: { file: string; done: number; total: number }) => Effect.Effect<void>
    }) {
      yield* Ref.set(cancelled, false)
      const maxFileSizeBytes = input.maxFileSizeBytes ?? 1_048_576
      const patterns = yield* loadIgnorePatterns(input.root)
      const walkResult = yield* walkDirectory(input.root, maxFileSizeBytes, input.root, patterns).pipe(Effect.orDie)
      const allFiles = walkResult.files
      const codeFiles = allFiles.filter((f) => {
        const ext = path.extname(f).toLowerCase()
        const allowedExtensions = [
          ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
          ".py", ".pyw",
          ".zig",
          ".rs",
          ".go",
          ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh",
          ".java", ".kt",
          ".cs",
          ".swift",
          ".rb",
          ".php",
          ".sh", ".bat", ".ps1",
          ".sql",
          ".html", ".css",
          ".md"
        ]
        return allowedExtensions.includes(ext)
      })

      const indexedRef = yield* Ref.make(0)
      const skippedRef = yield* Ref.make(walkResult.skippedBySize)
      const total = codeFiles.length
      const progressCounter = yield* Ref.make(0)

      yield* Effect.forEach(
        codeFiles,
        (filePath) => {
          const relativePath = path.relative(input.root, filePath).replace(/\\/g, "/")
          return Effect.gen(function* () {
            const isCancelled = yield* Ref.get(cancelled)
            if (isCancelled) return

            const ext = path.extname(filePath).toLowerCase()
            const content = yield* fs.readFileStringSafe(filePath)
            if (content === undefined) {
              yield* Ref.update(skippedRef, (n) => n + 1)
              return
            }

            // Safeguard: skip files exceeding maxFileSizeBytes or with lines longer than 5000 chars
            if (content.length > maxFileSizeBytes) {
              yield* Effect.logWarning(`Skipping large file (potential bundle): ${relativePath} (${content.length} chars, limit: ${maxFileSizeBytes})`)
              yield* Ref.update(skippedRef, (n) => n + 1)
              return
            }
            const hasTooLongLine = content.split("\n").some((line) => line.length > 5000)
            if (hasTooLongLine) {
              yield* Effect.logWarning(`Skipping minified/compiled file: ${relativePath}`)
              yield* Ref.update(skippedRef, (n) => n + 1)
              return
            }

            const contentHash = hashContent(content)
            const existing = yield* repo.getFileByPath(filePath)
            if (existing && existing.contentHash === contentHash && !input.force) {
              yield* Ref.update(skippedRef, (n) => n + 1)
              return
            }

            const parser = getParser(ext)
            const result = parser.parse(content, filePath)
            let language = "generic"
            if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mts" || ext === ".cts" || ext === ".mjs" || ext === ".cjs") {
              language = "typescript"
            } else if (ext === ".py" || ext === ".pyw") {
              language = "python"
            } else if (ext === ".zig") {
              language = "zig"
            } else if (ext === ".rs") {
              language = "rust"
            } else if (ext === ".go") {
              language = "go"
            } else if (ext === ".c" || ext === ".cpp" || ext === ".cc" || ext === ".cxx" || ext === ".h" || ext === ".hpp" || ext === ".hh") {
              language = "c_cpp"
            } else if (ext === ".java" || ext === ".kt") {
              language = "java"
            } else if (ext === ".cs") {
              language = "csharp"
            } else if (ext === ".swift") {
              language = "swift"
            } else if (ext === ".rb") {
              language = "ruby"
            } else if (ext === ".php") {
              language = "php"
            } else if (ext === ".sh" || ext === ".bat" || ext === ".ps1") {
              language = "shell"
            } else if (ext === ".sql") {
              language = "sql"
            } else if (ext === ".html" || ext === ".css") {
              language = "web"
            } else if (ext === ".md") {
              language = "markdown"
            }

            if (existing) {
              yield* repo.deleteFile(existing.id)
            }
            const fileID = existing?.id ?? randomUUID()
            const indexedAt = Date.now()
            yield* repo.putFile({ id: fileID, path: filePath, contentHash, language, indexedAt })
            for (const node of result.nodes) {
              const fullNode: CodegraphNode = {
                id: node.id,
                fileID,
                kind: node.kind,
                name: node.name,
                signature: node.signature,
                startLine: node.startLine,
                endLine: node.endLine,
                code: node.code,
              }
              yield* repo.putNode(fullNode)
            }
            for (const edge of result.edges) {
              yield* repo.putEdge({ id: edge.id, fromNodeID: edge.fromNodeID, toNodeID: edge.toNodeID, kind: edge.kind })
            }

            yield* Ref.update(indexedRef, (n) => n + 1)
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(`Failed to index file: ${relativePath}`, { cause: Cause.pretty(cause) })
                yield* Ref.update(skippedRef, (n) => n + 1)
              }),
            ),
            Effect.ensuring(
              Effect.gen(function* () {
                const doneCount = yield* Ref.updateAndGet(progressCounter, (n) => n + 1)
                if (input.onProgress) {
                  yield* input.onProgress({ file: relativePath, done: doneCount, total })
                }
              })
            )
          )
        },
        { concurrency: 8, discard: true }
      )

      const isCancelled = yield* Ref.get(cancelled)
      if (!isCancelled) {
        const allNodes = yield* repo.listAllNodes()
        const nodeMap = new Map<string, CodegraphNode[]>()
        for (const node of allNodes) {
          const list = nodeMap.get(node.name) ?? []
          list.push(node)
          nodeMap.set(node.name, list)
        }

        const newEdges: { fromNodeID: string; toNodeID: string; kind: "imports" | "calls" | "extends" | "references" }[] = []

        for (const nodeA of allNodes) {
          if (!nodeA.code) continue

          const wordsWithDots = nodeA.code.split(/[^a-zA-Z0-9_.]+/).filter(Boolean)
          const words = nodeA.code.split(/[^a-zA-Z0-9_]+/).filter(Boolean)

          const checkedNames = new Set<string>()

          const checkName = (name: string) => {
            if (checkedNames.has(name)) return
            checkedNames.add(name)
            const targets = nodeMap.get(name)
            if (!targets) return

            for (const nodeB of targets) {
              if (nodeB.id === nodeA.id) continue

              let kind: "calls" | "extends" | "references" = "references"
              if (nodeA.kind === "class" && new RegExp(`class\\s+\\w+\\s+(?:extends|implements)\\s+${escapeRegex(name)}\\b`).test(nodeA.code!)) {
                kind = "extends"
              } else if (new RegExp(`\\b${escapeRegex(name)}\\s*\\(`).test(nodeA.code!)) {
                kind = "calls"
              }

              newEdges.push({
                fromNodeID: nodeA.id,
                toNodeID: nodeB.id,
                kind,
              })
            }
          }

          for (const w of words) checkName(w)
          for (const w of wordsWithDots) {
            if (w.includes(".")) {
              checkName(w)
            }
          }
        }

        const edgesToWrite = newEdges.map((e) => ({
          id: `${e.fromNodeID}->${e.toNodeID}:${e.kind}`,
          fromNodeID: e.fromNodeID,
          toNodeID: e.toNodeID,
          kind: e.kind,
        }))
        yield* repo.putEdges(edgesToWrite)
      }

      const indexed = yield* Ref.get(indexedRef)
      const skipped = yield* Ref.get(skippedRef)
      return { indexed, skipped, scannedFiles: indexed + skipped }
    })

    const cancel = Effect.fn("CodegraphIndexer.cancel")(function* () {
      yield* Ref.set(cancelled, true)
    })

    return Service.of({ index, cancel })
  }),
)

function globToRegex(pattern: string): RegExp {
  let regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (!regexStr.startsWith(".*")) {
    regexStr = "^" + regexStr
  }
  if (!regexStr.endsWith(".*")) {
    regexStr = regexStr + "$"
  }
  return new RegExp(regexStr)
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
}

export const defaultLayer = layer.pipe(Layer.provide(CodegraphRepo.defaultLayer))
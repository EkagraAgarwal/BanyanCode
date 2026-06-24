export * as CodegraphIndexer from "./codegraph-indexer"

import { Cause, Context, Effect, Layer, Ref, Schema } from "effect"
import { randomUUID } from "node:crypto"
import path from "path"
import { FSUtil } from "../fs-util"
import { CodegraphRepo } from "./codegraph-repo"
import type { CodegraphEdge, CodegraphNode } from "./types"
import { ensureParsers, parseSource } from "./langs/registry"

export class CodegraphError extends Schema.TaggedErrorClass<CodegraphError>()("Banyan/CodegraphError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly index: (input: {
    root: string
    force?: boolean
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

    const walkDirectory = (dir: string): Effect.Effect<string[]> => {
      return Effect.gen(function* () {
        const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.orDie)
        const files: string[] = []
        for (const entry of entries) {
          if (entry.type !== "directory") continue
          const entryName = path.basename(entry.name)
          if (DEFAULT_IGNORED.includes(entryName)) continue
          const fullPath = path.join(dir, entryName)
          const subFiles = yield* walkDirectory(fullPath)
          files.push(...subFiles)
        }
        const dirFiles = entries
          .filter((e) => e.type === "file")
          .map((e) => path.join(dir, e.name))
        files.push(...dirFiles)
        return files
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
      onProgress?: (info: { file: string; done: number; total: number }) => Effect.Effect<void>
    }) {
      yield* Ref.set(cancelled, false)
      yield* Effect.promise(() => ensureParsers())
      const patterns = yield* loadIgnorePatterns(input.root)
      const allFiles = yield* walkDirectory(input.root).pipe(Effect.orDie)
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
        return allowedExtensions.includes(ext) && !isIgnored(patterns, input.root, f)
      })
      let indexed = 0
      let skipped = 0
      const total = codeFiles.length
      for (let i = 0; i < codeFiles.length; i++) {
const isCancelled = yield* Ref.get(cancelled)
      if (isCancelled) break
      const filePath = codeFiles[i]
      const relativePath = path.relative(input.root, filePath).replace(/\\/g, "/")
      if (input.onProgress) yield* input.onProgress({ file: relativePath, done: i, total })
      const ext = path.extname(filePath).toLowerCase()
      const indexStartedAt = Date.now()
        const processFile = Effect.gen(function* () {
          const content = yield* fs.readFileStringSafe(filePath)
          if (content === undefined) {
            skipped++
            return
          }
          // Safeguard: skip files > 500 KB or with lines longer than 5000 chars (potential compiled bundles or minified assets)
          if (content.length > 500000) {
            yield* Effect.logWarning(`Skipping large file (potential bundle): ${relativePath} (${content.length} chars)`)
            skipped++
            return
          }
          const hasTooLongLine = content.split("\n").some((line) => line.length > 5000)
          if (hasTooLongLine) {
            yield* Effect.logWarning(`Skipping minified/compiled file: ${relativePath}`)
            skipped++
            return
          }
          const contentHash = hashContent(content)
          const existing = yield* repo.getFileByPath(filePath)
          if (existing && existing.contentHash === contentHash && !input.force) {
            skipped++
            return
          }
          const result = parseSource(ext, content, filePath)
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
          indexed++
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning(`Failed to index file: ${relativePath}`, { cause: Cause.pretty(cause) })
              skipped++
            }),
          ),
        )
        yield* processFile
      }

      const isCancelled = yield* Ref.get(cancelled)
      if (!isCancelled) {
        if (input.onProgress) yield* input.onProgress({ file: "__finalize__:loading nodes", done: total, total })
        const allNodes = yield* repo.listAllNodes()
        if (input.onProgress) yield* input.onProgress({ file: "__finalize__:loading nodes", done: total, total: total + allNodes.length })
        const nodeMap = new Map<string, CodegraphNode[]>()
        for (const node of allNodes) {
          const list = nodeMap.get(node.name) ?? []
          list.push(node)
          nodeMap.set(node.name, list)
        }

        const newEdges: { fromNodeID: string; toNodeID: string; kind: "imports" | "calls" | "extends" | "references" }[] = []
        const totalEdgesTarget = total + allNodes.length
        let edgesProcessed = 0

        for (const nodeA of allNodes) {
          if (!nodeA.code) continue

          const wordsWithDots = new Set(nodeA.code.split(/[^a-zA-Z0-9_.]+/))
          const words = new Set(nodeA.code.split(/[^a-zA-Z0-9_]+/))

          for (const [name, targets] of nodeMap.entries()) {
            const hasRef = name.includes(".") ? wordsWithDots.has(name) : words.has(name)
            if (!hasRef) continue

            for (const nodeB of targets) {
              if (nodeB.id === nodeA.id) continue

              let kind: "calls" | "extends" | "references" = "references"
              if (nodeA.kind === "class" && new RegExp(`class\\s+\\w+\\s+(?:extends|implements)\\s+${escapeRegex(name)}\\b`).test(nodeA.code)) {
                kind = "extends"
              } else if (new RegExp(`\\b${escapeRegex(name)}\\s*\\(`).test(nodeA.code)) {
                kind = "calls"
              }

              newEdges.push({
                fromNodeID: nodeA.id,
                toNodeID: nodeB.id,
                kind,
              })
            }
          }
          edgesProcessed++
          if (input.onProgress && edgesProcessed % 200 === 0) {
            yield* input.onProgress({ file: "__finalize__:building edges", done: total + edgesProcessed, total: totalEdgesTarget })
          }
        }
        if (input.onProgress) yield* input.onProgress({ file: "__finalize__:building edges", done: totalEdgesTarget, total: totalEdgesTarget })

        if (newEdges.length > 0) {
          yield* repo.putEdges(
            newEdges.map((edge) => ({
              id: `${edge.fromNodeID}->${edge.toNodeID}:${edge.kind}`,
              fromNodeID: edge.fromNodeID,
              toNodeID: edge.toNodeID,
              kind: edge.kind,
            })),
          )
        }
      }

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
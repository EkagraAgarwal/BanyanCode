export * as CodegraphIndexer from "./codegraph-indexer"

import { Context, Effect, Layer, Ref, Schema } from "effect"
import path from "path"
import { FSUtil } from "../fs-util"
import { CodegraphRepo } from "./codegraph-repo"
import type { CodegraphNode } from "./types"
import { getParser } from "./langs/registry"

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

    const isIgnored = (patterns: string[], filePath: string): boolean => {
      const relative = filePath.replace(/\\/g, "/")
      for (const pattern of patterns) {
        if (pattern === "") continue
        const regex = globToRegex(pattern)
        if (regex.test(relative)) return true
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
      const patterns = yield* loadIgnorePatterns(input.root)
      const allFiles = yield* walkDirectory(input.root).pipe(Effect.orDie)
      const codeFiles = allFiles.filter((f) => {
        const ext = path.extname(f).toLowerCase()
        return [".ts", ".tsx", ".js", ".jsx", ".py"].includes(ext) && !isIgnored(patterns, f)
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
        const content = yield* fs.readFileStringSafe(filePath).pipe(Effect.orDie)
        if (content === undefined) continue
        const contentHash = hashContent(content)
        const existing = yield* repo.getFileByPath(filePath)
        if (existing && existing.contentHash === contentHash && !input.force) {
          skipped++
          continue
        }
        const parser = getParser(ext)
        const language = ext === ".py" ? "python" : "typescript"
        const fileID = existing?.id ?? crypto.randomUUID()
        const result = parser.parse(content, fileID, filePath, language)
        const indexedAt = Date.now()
        yield* repo.putFile({ id: fileID, rootID: input.root, path: filePath, contentHash, byteSize: content.length, language, indexedAt })
        for (const node of result.nodes) {
          const fullNode: CodegraphNode = {
            id: node.id,
            fileID,
            kind: node.kind,
            name: node.name,
            qualifiedName: node.qualifiedName,
            startLine: node.startLine,
            startByte: node.startByte,
            endLine: node.endLine,
            endByte: node.endByte,
            language,
            signature: node.signature,
            doc: node.doc,
            textExcerpt: node.textExcerpt,
            nodeCodeHash: node.nodeCodeHash,
            code: node.code,
          }
          yield* repo.putNode(fullNode)
        }
        for (const edge of result.edges) {
          yield* repo.putEdge({ id: edge.id, fromNodeID: edge.fromNodeID, toNodeID: edge.toNodeID, toTargetKey: edge.toTargetKey, fileID, line: edge.line, kind: edge.kind, weight: edge.weight })
        }
        indexed++
      }
      return { indexed, skipped }
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

export const defaultLayer = layer.pipe(Layer.provide(CodegraphRepo.defaultLayer))
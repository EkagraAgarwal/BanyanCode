export * as CodegraphIndexer from "./codegraph-indexer"

import { Cause, Context, Effect, Layer, Queue, Ref, Schema } from "effect"
import { randomUUID } from "node:crypto"
import path from "path"
import { FSUtil } from "../fs-util"
import { CodegraphRepo } from "./codegraph-repo"
import { Database } from "../database/database"
import type { CodegraphEdge, CodegraphFile, CodegraphNode, CodegraphNodeKind } from "./types"
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
    const database = yield* Database.Service
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

    const classifyFileKind = (filePath: string, content: string): CodegraphNodeKind | undefined => {
      const base = path.basename(filePath)
      const lower = base.toLowerCase()
      if (/\.(test|spec)\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i.test(base)) return "test"
      if (lower === "package.json") return "package"
      if (/\.config\.(json|js|ts)$/i.test(base) || lower === "config.json") return "config"
      if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "build"
      if (/\.generated\.(ts|js)$/i.test(base)) return "generated"
      if (/code generated by/i.test(content)) return "generated"
      if (/app\.(get|post|put|delete|patch|all|use)\s*\(/m.test(content)) return "route"
      return undefined
    }

    const artifactFileName = (filePath: string, kind: CodegraphNodeKind): string => {
      const base = path.basename(filePath)
      if (kind === "package") return "package"
      if (kind === "build") return base
      const ext = path.extname(base)
      return ext ? base.slice(0, -ext.length) : base
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
      const codeExtensions = new Set([
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
        ".md",
      ])
      const isArtifactPath = (filePath: string) => {
        const base = path.basename(filePath)
        const lower = base.toLowerCase()
        return (
          lower === "package.json" ||
          lower === "dockerfile" ||
          lower.startsWith("dockerfile.") ||
          /\.config\.(json|js|ts)$/i.test(base) ||
          lower === "config.json"
        )
      }
      const codeFiles = allFiles.filter((f) => {
        const ext = path.extname(f).toLowerCase()
        return codeExtensions.has(ext) || isArtifactPath(f)
      })

      const indexedRef = yield* Ref.make(0)
      const skippedRef = yield* Ref.make(walkResult.skippedBySize)
      const total = codeFiles.length
      const progressCounter = yield* Ref.make(0)

      // Channel-based pipeline: 8 parse fibers run in parallel and offer parsed
// file data into a bounded queue; a single writer fiber drains the queue
// and commits each file as one transaction. The queue length is bounded
// so memory stays flat even with thousands of files. Replacing the previous
// concurrency:8 + per-file N-statement-write pattern removed the ~15
// individual auto-committed writes per file (which was the primary cause
// of the 1+ GB WAL during real-workspace builds).
type ParsedFile = {
  readonly file: CodegraphFile
  readonly nodes: CodegraphNode[]
  readonly edges: CodegraphEdge[]
  readonly relativePath: string
  readonly skipped: boolean
  readonly previousFileID?: string
}
const parsedQueue = yield* Queue.bounded<ParsedFile>(128)

const parseFiber = (filePath: string): Effect.Effect<void, never, never> => {
  const relativePath = path.relative(input.root, filePath).replace(/\\/g, "/")
  return Effect.gen(function* () {
    if (yield* Ref.get(cancelled)) return

    const ext = path.extname(filePath).toLowerCase()
    const content = yield* fs.readFileStringSafe(filePath)
    if (content === undefined) {
      yield* Ref.update(skippedRef, (n) => n + 1)
      yield* Queue.offer(parsedQueue, { file: { id: "", path: filePath, contentHash: "", language: "", indexedAt: 0 }, nodes: [], edges: [], relativePath, skipped: true })
      return
    }

    if (content.length > maxFileSizeBytes) {
      yield* Effect.logWarning(`Skipping large file (potential bundle): ${relativePath} (${content.length} chars, limit: ${maxFileSizeBytes})`)
      yield* Ref.update(skippedRef, (n) => n + 1)
      yield* Queue.offer(parsedQueue, { file: { id: "", path: filePath, contentHash: "", language: "", indexedAt: 0 }, nodes: [], edges: [], relativePath, skipped: true })
      return
    }
    if (content.split("\n").some((line) => line.length > 5000)) {
      yield* Effect.logWarning(`Skipping minified/compiled file: ${relativePath}`)
      yield* Ref.update(skippedRef, (n) => n + 1)
      yield* Queue.offer(parsedQueue, { file: { id: "", path: filePath, contentHash: "", language: "", indexedAt: 0 }, nodes: [], edges: [], relativePath, skipped: true })
      return
    }

    const contentHash = hashContent(content)
    const existing = yield* repo.getFileByPath(filePath)
    if (existing && existing.contentHash === contentHash && !input.force) {
      yield* Ref.update(skippedRef, (n) => n + 1)
      yield* Queue.offer(parsedQueue, { file: { id: "", path: filePath, contentHash: "", language: "", indexedAt: 0 }, nodes: [], edges: [], relativePath, skipped: true })
      return
    }

    const parser = getParser(ext)
    const result = isArtifactPath(filePath)
      ? { nodes: [], edges: [] }
      : parser.parse(content, filePath)
    let language = "generic"
    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mts" || ext === ".cts" || ext === ".mjs" || ext === ".cjs") language = "typescript"
    else if (ext === ".py" || ext === ".pyw") language = "python"
    else if (ext === ".zig") language = "zig"
    else if (ext === ".rs") language = "rust"
    else if (ext === ".go") language = "go"
    else if (ext === ".c" || ext === ".cpp" || ext === ".cc" || ext === ".cxx" || ext === ".h" || ext === ".hpp" || ext === ".hh") language = "c_cpp"
    else if (ext === ".java" || ext === ".kt") language = "java"
    else if (ext === ".cs") language = "csharp"
    else if (ext === ".swift") language = "swift"
    else if (ext === ".rb") language = "ruby"
    else if (ext === ".php") language = "php"
    else if (ext === ".sh" || ext === ".bat" || ext === ".ps1") language = "shell"
    else if (ext === ".sql") language = "sql"
    else if (ext === ".html" || ext === ".css") language = "web"
    else if (ext === ".md") language = "markdown"

    const fileID = existing?.id ?? randomUUID()
    const indexedAt = Date.now()
    const file: CodegraphFile = { id: fileID, path: filePath, contentHash, language, indexedAt }
    const nodes: CodegraphNode[] = result.nodes.map((n) => ({
      id: n.id,
      fileID,
      kind: n.kind,
      name: n.name,
      signature: n.signature,
      startLine: n.startLine,
      endLine: n.endLine,
      code: n.code,
    }))
    const edges: CodegraphEdge[] = result.edges.map((e) => ({
      id: e.id,
      fromNodeID: e.fromNodeID,
      toNodeID: e.toNodeID,
      kind: e.kind,
    }))

    const fileKind = classifyFileKind(filePath, content)
    if (fileKind) {
      const lineCount = content.split("\n").length
      nodes.push({
        id: `${fileID}:artifact:${fileKind}`,
        fileID,
        kind: fileKind,
        name: artifactFileName(filePath, fileKind),
        signature: relativePath,
        startLine: 1,
        endLine: lineCount,
        code: content,
      })
    }

    yield* Queue.offer(parsedQueue, {
      file,
      nodes,
      edges,
      relativePath,
      skipped: false,
      previousFileID: existing?.id,
    })
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
      }),
    ),
  )
}

// Producer/consumer pipeline. Producers (parseFiber) run concurrently and
// offer parsed file data into a bounded queue. The consumer drains the
// queue serially via Queue.take + a counter, exiting once `codeFiles.length`
// items have been observed. Bounded queue gives us natural backpressure:
// slow producers wait when the consumer is busy; slow consumer causes
// producers to block on Queue.offer, which throttles their concurrency.
const CHECKPOINT_EVERY = 200
const writesSinceCheckpoint = yield* Ref.make(0)

yield* Effect.forEach(codeFiles, parseFiber, { concurrency: 8, discard: true })

// After all parse fibers return, the queue may still hold items. Drain
// them all synchronously here (we know exactly how many to expect: one
// per codeFiles entry, since every parseFiber calls Queue.offer exactly
// once before returning).
let processed = 0
const totalExpected = codeFiles.length
while (processed < totalExpected) {
  const parsed = yield* Queue.take(parsedQueue)
  processed++
  if (parsed.skipped) continue
  yield* repo.writeFileGraph({
    file: parsed.file,
    nodes: parsed.nodes,
    edges: parsed.edges,
    ...(parsed.previousFileID !== undefined ? { previousFileID: parsed.previousFileID } : {}),
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logWarning(`Failed to write file: ${parsed.relativePath}`, {
          cause: Cause.pretty(cause),
        })
        yield* Ref.update(skippedRef, (n) => n + 1)
      }),
    ),
  )
  yield* Ref.update(indexedRef, (n) => n + 1)
  if (processed % CHECKPOINT_EVERY === 0) {
    yield* database.db.run("PRAGMA wal_checkpoint(PASSIVE)").pipe(Effect.ignore)
  }
}
// Shut down the queue to release any resources (now safe: we've drained
// every item we expect).
yield* Queue.shutdown(parsedQueue)
// Final checkpoint regardless of how many files we processed.
yield* database.db.run("PRAGMA wal_checkpoint(PASSIVE)").pipe(Effect.ignore)

      const isCancelled = yield* Ref.get(cancelled)
      if (!isCancelled) {
        const allNodes = yield* repo.listAllNodes()
        const allFiles = yield* repo.listAllFiles()
        const fileByID = new Map(allFiles.map((f) => [f.id, f]))
        const fileDir = (filePath: string) => path.dirname(filePath)

        const nodeMap = new Map<string, CodegraphNode[]>()
        const nodesByFileID = new Map<string, CodegraphNode[]>()
        for (const node of allNodes) {
          const list = nodeMap.get(node.name) ?? []
          list.push(node)
          nodeMap.set(node.name, list)
          const fileList = nodesByFileID.get(node.fileID) ?? []
          fileList.push(node)
          nodesByFileID.set(node.fileID, fileList)
        }

        const referenceEdges: { fromNodeID: string; toNodeID: string; kind: "imports" | "calls" | "extends" | "references" }[] = []
        const crossEdges: { fromNodeID: string; toNodeID: string; kind: CodegraphEdge["kind"] }[] = []

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

              referenceEdges.push({
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

        const packageNodes = allNodes.filter((n) => n.kind === "package")
        const buildNodes = allNodes.filter((n) => n.kind === "build")
        const testNodes = allNodes.filter((n) => n.kind === "test")
        const routeNodes = allNodes.filter((n) => n.kind === "route")
        const generatedNodes = allNodes.filter((n) => n.kind === "generated")

        for (const testNode of testNodes) {
          if (yield* Ref.get(cancelled)) {
            yield* Effect.logWarning("codegraph: cancelled during tested_by")
            break
          }
          const testFile = fileByID.get(testNode.fileID)
          if (!testFile || !testNode.code) continue
          // Tokenize the test file's source once into a unique identifier set,
          // then for each identifier look it up in the name -> nodes index
          // instead of substring-scanning the full test code for every
          // production node. 3,067-file workspaces were taking >5 min here.
          const referenced = new Set<string>()
          for (const m of testNode.code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
            referenced.add(m[0])
          }
          for (const name of referenced) {
            const candidates = nodeMap.get(name)
            if (!candidates) continue
            for (const node of candidates) {
              if (node.fileID === testNode.fileID) continue
              if (node.kind === "test") continue
              const nodeFile = fileByID.get(node.fileID)
              if (!nodeFile) continue
              if (/\.(test|spec)\./i.test(nodeFile.path.toLowerCase())) continue
              crossEdges.push({ fromNodeID: node.id, toNodeID: testNode.id, kind: "tested_by" })
            }
          }
        }

        for (const pkg of packageNodes) {
          if (yield* Ref.get(cancelled)) {
            yield* Effect.logWarning("codegraph: cancelled during configured_by")
            break
          }
          const pkgFile = fileByID.get(pkg.fileID)
          if (!pkgFile) continue
          const pkgDir = fileDir(pkgFile.path)
          for (const file of allFiles) {
            if (fileDir(file.path) !== pkgDir) continue
            if (file.id === pkg.fileID) continue
            const fileNodes = nodesByFileID.get(file.id) ?? []
            const fromNode = fileNodes.find((n) => n.kind !== "package") ?? fileNodes[0]
            if (!fromNode) continue
            crossEdges.push({ fromNodeID: fromNode.id, toNodeID: pkg.id, kind: "configured_by" })
          }
        }

        for (const pkg of packageNodes) {
          const pkgFile = fileByID.get(pkg.fileID)
          if (!pkgFile) continue
          const pkgDir = fileDir(pkgFile.path)
          const docker = buildNodes.find((n) => {
            const f = fileByID.get(n.fileID)
            return f ? fileDir(f.path) === pkgDir : false
          })
          if (docker) crossEdges.push({ fromNodeID: pkg.id, toNodeID: docker.id, kind: "built_by" })
        }

        if (yield* Ref.get(cancelled)) {
          yield* Effect.logWarning("codegraph: cancelled before mounts")
          // Fall through; the putEdges call below will simply write what we have so far.
        } else {
          const routeHandlerRegex = /app\.(?:get|post|put|delete|patch|all|use)\s*\([^,]+,\s*(\w+)\s*\)/g
          for (const routeNode of routeNodes) {
            if (!routeNode.code) continue
            for (const match of routeNode.code.matchAll(routeHandlerRegex)) {
              const handlerName = match[1]
              const handlers = nodeMap.get(handlerName)
              const handler = handlers?.find((n) => n.fileID === routeNode.fileID)
              if (handler) crossEdges.push({ fromNodeID: routeNode.id, toNodeID: handler.id, kind: "mounts" })
            }
          }

          for (const gen of generatedNodes) {
            if (yield* Ref.get(cancelled)) {
              yield* Effect.logWarning("codegraph: cancelled during generated_from")
              break
            }
            const genFile = fileByID.get(gen.fileID)
            if (!genFile) continue
            const genDir = fileDir(genFile.path)
            const genBase = path.basename(genFile.path).replace(/\.generated(\.[^.]+)$/i, "$1")
            const sourceFile = allFiles.find(
              (f) => fileDir(f.path) === genDir && path.basename(f.path) === genBase,
            )
            if (!sourceFile) continue
            const sourceNodes = nodesByFileID.get(sourceFile.id)
            const sourceNode = sourceNodes?.find((n) => n.kind !== "generated") ?? sourceNodes?.[0]
            if (sourceNode) crossEdges.push({ fromNodeID: gen.id, toNodeID: sourceNode.id, kind: "generated_from" })
          }
        }

        const edgesToWrite = [
          ...referenceEdges.map((e) => ({
            id: `${e.fromNodeID}->${e.toNodeID}:${e.kind}`,
            fromNodeID: e.fromNodeID,
            toNodeID: e.toNodeID,
            kind: e.kind,
          })),
          ...crossEdges.map((e) => ({
            id: `${e.fromNodeID}->${e.toNodeID}:${e.kind}`,
            fromNodeID: e.fromNodeID,
            toNodeID: e.toNodeID,
            kind: e.kind,
          })),
        ]
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

// Note: CodegraphRepo.defaultLayer already provides Database.defaultLayer,
// so we don't provide it again here. Tests that need a custom DB path should
// build the layer as `CodegraphIndexer.layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(Database.layerFromPath(...)))`.
export const defaultLayer = layer.pipe(Layer.provide(CodegraphRepo.defaultLayer))
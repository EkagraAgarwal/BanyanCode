export * as CodegraphIndexer from "./codegraph-indexer"

import { Cause, Context, Effect, Layer, Queue, Ref, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import path from "path"
import { FSUtil } from "../fs-util"
import { CodegraphRepo } from "./codegraph-repo"
import { Database } from "../database/database"
import type { CodegraphEdge, CodegraphFile, CodegraphNode, CodegraphNodeKind } from "./types"
import { getParserForPath } from "./langs/registry"
import type { ParseResult } from "./langs/types"
import {
  ensureQuerySourcesLoaded,
  parseTypeScriptWithTreeSitterIncremental,
  parsePythonWithTreeSitterIncremental,
} from "./langs/query-executor"
import { ensureWebTreeSitterReady } from "./langs/tree-sitter"
import type { Tree } from "web-tree-sitter"
import { extractTestFileImports } from "./codegraph-helpers"

const TS_LIKE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"])
const PY_LIKE_EXTS = new Set([".py", ".pyw"])

// Phase 3 entrypoint heuristic — kept here (not in repository-intelligence)
// because it must run during the parse pass so the column lands in the DB
// the same build that writes the node. The function/class/method kinds are
// the entrypoint candidates: routes (app.get(...)), CLI handlers
// (cli-handler / cmd-* names), paths under commands/cli/routes/handlers,
// and the bin/main export of any package.json.
const ENTRYPOINT_PATH_PATTERNS = [
  /\/commands?\//i,
  /\/cli\//i,
  /\/routes?\//i,
  /\/handlers?\//i,
  /\/bin\//i,
  /\/scripts?\//i,
]
const ENTRYPOINT_NAME_HINTS = /(handler|^main$|mainFn|mainHandler|^route$|^cmd$|^command$|^setup$|^bootstrap$)/i
const ROUTE_REGEX_HINT = /\b(app|router|fastify|instance)\s*\.\s*(get|post|put|delete|patch|head|options|trace)\s*\(/i
const ENTRYPOINT_KINDS: ReadonlyArray<CodegraphNodeKind> = ["function", "class", "method"]

const isEntrypointNode = (node: Pick<CodegraphNode, "name" | "kind" | "code" | "signature">, filePath: string): boolean => {
  if (!ENTRYPOINT_KINDS.includes(node.kind)) return false
  if (ENTRYPOINT_NAME_HINTS.test(node.name)) return true
  if (ENTRYPOINT_PATH_PATTERNS.some((p) => p.test(filePath))) return true
  const sig = node.signature
  if (sig && ENTRYPOINT_PATH_PATTERNS.some((p) => p.test(sig))) return true
  if (node.code && ROUTE_REGEX_HINT.test(node.code)) return true
  return false
}

export class CodegraphError extends Schema.TaggedErrorClass<CodegraphError>()("Banyan/CodegraphError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly index: (input: {
    root: string
    force?: boolean
    maxFileSizeBytes?: number
    excludePatterns?: readonly string[]
    onProgress?: (info: { file: string; done: number; total: number; currentFile?: string }) => Effect.Effect<void>
  }) => Effect.Effect<
    {
      indexed: number
      skipped: number
      scannedFiles: number
      /**
       * Phase 0+2: files the indexer considered eligible for indexing.
       * This is the union of (a) code/artifact candidates the walker
       * reached and passed extension/artifact filters, plus (b) code
       * candidates excluded only for size budget. Gitignored /
       * banyanignored files are NOT eligible (the indexer never sees
       * them). Cached files remain eligible.
       *
       * Important: previously this counted `allFiles.length` (every
       * walked file including non-code extensions like `.json`, `.lock`,
       * images). For a monorepo whose non-code files dominate, that
       * cap pushed coverage to ~0.62 and made the `STALENESS_COVERAGE_HIGH
       * = 0.5` cliff reachable. Denominator now counts only files the
       * indexer would actually attempt so a fully-cached rebuild scores
       * near 1.0.
       */
      eligibleFiles: number
      symbolsIndexed: number
      skippedByReason: {
        gitignored: number
        banyanignored: number
        artifact: number
        tooLarge: number
        minified: number
        tooLargeParse: number
        cached: number
        readError: number
        parseFailure: number
      }
      parseErrors: Array<{ path: string; cause: string; indexedAt: number }>
    },
    CodegraphError,
    never
  >
  readonly applyChanges: (input: {
    root: string
    addedOrChanged: string[]
    removed: string[]
    force?: boolean
    maxFileSizeBytes?: number
    excludePatterns?: readonly string[]
    onProgress?: (info: { file: string; done: number; total: number; currentFile?: string }) => Effect.Effect<void>
  }) => Effect.Effect<{
    indexed: number
    removed: number
    skipped: number
    parseErrors: Array<{ path: string; cause: string; indexedAt: number }>
  }>
  readonly indexFiles: (input: {
    root: string
    paths: string[]
    force?: boolean
    maxFileSizeBytes?: number
    excludePatterns?: readonly string[]
    onProgress?: (info: { file: string; done: number; total: number; currentFile?: string }) => Effect.Effect<void>
  }) => Effect.Effect<{
    indexed: number
    skipped: number
    parseErrors: Array<{ path: string; cause: string; indexedAt: number }>
  }>
  readonly removeFiles: (input: {
    root: string
    paths: string[]
  }) => Effect.Effect<void, never, never>
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

// Out-of-product UI packages that the codegraph never needs to index.
// These are out of scope per AGENTS.md ("desktop, web, app, storybook
// packages are explicitly out of scope"). They are still respected
// when the user explicitly lists them in `banyancode_codegraph_exclude_patterns`
// or `.banyancode/ignore`, but they are also excluded by default so
// that a fresh build does not waste time walking packages/desktop etc.
const DEFAULT_PRODUCT_EXCLUDES = [
  "packages/web",
  "packages/app",
  "packages/desktop",
  "packages/storybook",
]

// Plan Phase 5: cap the tree-sitter cache so a long-lived indexer cannot
// retain hundreds of MB of native parse trees. Trees past the cap are
// dropped (treated as cold on next access). 1000 trees ≈ a few hundred MB
// at typical sizes, well below any reasonable memory budget.
const TREE_CACHE_CAP = 1000

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const repo = yield* CodegraphRepo.Service
    const database = yield* Database.Service
    const cancelled = yield* Ref.make(false)
    const treeCacheRef = yield* Ref.make(new Map<string, Tree>())

    // Warm the grammar cache so per-file parses never read `.scm` from disk.
    yield* Effect.promise(() => ensureQuerySourcesLoaded())
    // Initialize tree-sitter state, but never fail layer construction.
    yield* ensureWebTreeSitterReady()

    const pruneTreeCache = Effect.fn("CodegraphIndexer.pruneTreeCache")(function* () {
      yield* Ref.update(treeCacheRef, (m) => {
        if (m.size <= TREE_CACHE_CAP) return m
        const overflow = m.size - TREE_CACHE_CAP
        const keysToDelete: string[] = []
        for (const key of m.keys()) {
          keysToDelete.push(key)
          if (keysToDelete.length >= overflow) break
        }
        for (const key of keysToDelete) m.delete(key)
        return m
      })
    })

    const dropTreeCacheFor = (filePath: string) =>
      Ref.update(treeCacheRef, (m) => {
        m.delete(filePath)
        return m
      })
    const walkDirectory = (
      dir: string,
      maxFileSizeBytes: number,
      root: string,
      gitignorePatterns: string[],
      banyanignorePatterns: string[],
    ): Effect.Effect<{ files: CandidateFile[]; skippedBySize: number; skippedByGitignore: number; skippedByBanyanignore: number }> => {
      return Effect.gen(function* () {
        const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.orDie)
        const files: CandidateFile[] = []
        let skippedBySize = 0
        let skippedByGitignore = 0
        let skippedByBanyanignore = 0
        for (const entry of entries) {
          if (entry.type !== "directory") continue
          const entryName = path.basename(entry.name)
          if (DEFAULT_IGNORED.includes(entryName)) {
            skippedByGitignore++
            continue
          }
          const fullPath = path.join(dir, entryName)
          if (isIgnoredByPatterns(gitignorePatterns, root, fullPath)) {
            skippedByGitignore++
            continue
          }
          if (isIgnoredByPatterns(banyanignorePatterns, root, fullPath)) {
            skippedByBanyanignore++
            continue
          }
          const subResult = yield* walkDirectory(fullPath, maxFileSizeBytes, root, gitignorePatterns, banyanignorePatterns)
          files.push(...subResult.files)
          skippedBySize += subResult.skippedBySize
          skippedByGitignore += subResult.skippedByGitignore
          skippedByBanyanignore += subResult.skippedByBanyanignore
        }
        for (const entry of entries) {
          if (entry.type !== "file") continue
          const fullPath = path.join(dir, entry.name)
          if (isIgnoredByPatterns(gitignorePatterns, root, fullPath)) {
            skippedByGitignore++
            continue
          }
          if (isIgnoredByPatterns(banyanignorePatterns, root, fullPath)) {
            skippedByBanyanignore++
            continue
          }
          const stats = yield* fs.stat(fullPath).pipe(Effect.orDie)
          if (stats.size > maxFileSizeBytes) {
            yield* Effect.logWarning(`Skipping file exceeding size limit: ${path.relative(root, fullPath).replace(/\\/g, "/")} (${stats.size} bytes)`)
            skippedBySize++
            continue
          }
          files.push({
            path: fullPath,
            sizeBytes: Number(stats.size),
            mtimeMs: "value" in stats.mtime ? Math.floor(stats.mtime.value.getTime()) : 0,
          })
        }
        return { files, skippedBySize, skippedByGitignore, skippedByBanyanignore }
      })
    }

    const loadIgnorePatterns = (root: string, excludePatterns?: readonly string[]): Effect.Effect<{ gitignore: string[]; banyanignore: string[] }> => {
      return Effect.gen(function* () {
        const gitignore: string[] = [...DEFAULT_IGNORED, ...DEFAULT_PRODUCT_EXCLUDES]
        const banyanignore: string[] = []
        const gitignorePath = path.join(root, ".gitignore")
        const banyancodeignorePath = path.join(root, ".banyancode", "ignore")
        const gitignoreExists = yield* fs.existsSafe(gitignorePath)
        if (gitignoreExists) {
          const content = yield* fs.readFileStringSafe(gitignorePath).pipe(Effect.orDie)
          if (content) gitignore.push(...content.split("\n").filter((l) => l.trim() && !l.startsWith("#")))
        }
        const banyancodeExists = yield* fs.existsSafe(banyancodeignorePath)
        if (banyancodeExists) {
          const content = yield* fs.readFileStringSafe(banyancodeignorePath).pipe(Effect.orDie)
          if (content) banyanignore.push(...content.split("\n").filter((l) => l.trim() && !l.startsWith("#")))
        }
        if (excludePatterns && excludePatterns.length > 0) {
          for (const p of excludePatterns) {
            const trimmed = p.trim()
            if (trimmed) banyanignore.push(trimmed)
          }
        }
        return { gitignore, banyanignore }
      })
    }

    const isIgnoredByPatterns = (patterns: string[], root: string, filePath: string): boolean => {
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
      return createHash("sha256").update(content).digest("hex")
    }

    const classifyFileKind = (filePath: string, content: string): CodegraphNodeKind | undefined => {
      const base = path.basename(filePath)
      const lower = base.toLowerCase()
      const normPath = filePath.replace(/\\/g, "/")
      if (/\.(test|spec)\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i.test(base)) return "test"

      if (lower.endsWith(".md")) return "doc"
      if (lower.startsWith("readme")) return "doc"
      if (lower.startsWith("changelog")) return "doc"
      if (lower.startsWith("contributing")) return "doc"
      if (lower.startsWith("design") && lower.endsWith(".md")) return "doc"
      if (/\/(?:docs|rfcs)\/.*\.md$/i.test(normPath)) return "doc"

      if (lower === "dockerfile" || lower.startsWith("dockerfile.") || lower.endsWith(".dockerfile")) return "docker"
      if (lower === "compose.yml" || lower === "compose.yaml") return "docker"
      if (lower === "docker-compose.yml" || lower === "docker-compose.yaml") return "docker"

      if (/\/\.github\/workflows\/.+\.(yml|yaml)$/i.test(normPath)) return "ci"
      if (lower === ".gitlab-ci.yml") return "ci"
      if (lower === "jenkinsfile") return "ci"
      if (/\/\.circleci\/.+\.(yml|yaml)$/i.test(normPath)) return "ci"
      if (lower.startsWith("azure-pipelines") && lower.endsWith(".yml")) return "ci"

      if (lower.startsWith(".env")) return "env"
      if (lower === ".envrc") return "env"
      if (lower.startsWith("dotenv")) return "env"

      if (lower === "package.json") return "config"
      if (lower.startsWith("tsconfig") && lower.endsWith(".json")) return "config"
      if (lower === "pnpm-workspace.yaml" || lower === "pnpm-workspace.yml") return "config"
      if (lower === "pyproject.toml") return "config"
      if (lower === "cargo.toml") return "config"
      if (lower === "go.mod") return "config"
      if (/\.config\.(json|js|ts)$/i.test(base) || lower === "config.json") return "config"

      if (/\.generated\.(ts|js)$/i.test(base)) return "generated"
      if (/code generated by/i.test(content)) return "generated"
      if (/app\.(get|post|put|delete|patch|all|use)\s*\(/m.test(content)) return "route"
      return undefined
    }

    const artifactFileName = (filePath: string, kind: CodegraphNodeKind): string => {
      const base = path.basename(filePath)
      if (kind === "package") return "package"
      if (kind === "build") return base
      if (kind === "docker" || kind === "ci" || kind === "env") return base
      const ext = path.extname(base)
      return ext ? base.slice(0, -ext.length) : base
    }

    // Shared type and constants at layer factory level
type ParsedFile = {
  readonly file: CodegraphFile
  readonly nodes: CodegraphNode[]
  readonly edges: CodegraphEdge[]
  readonly relativePath: string
  readonly skipped: boolean
  readonly previousFileID?: string
}
const CHECKPOINT_EVERY = 1000
type CandidateFile = {
  readonly path: string
  readonly sizeBytes: number
  readonly mtimeMs: number
}

const indexCandidateFileCore = (
  candidate: CandidateFile,
  relativePath: string,
  cfg: {
    input: {
      root: string
      force?: boolean
      maxFileSizeBytes?: number
      onProgress?: (info: { file: string; done: number; total: number; currentFile?: string }) => Effect.Effect<void>
    }
    maxFileSizeBytes: number
    total: number
    parsedQueue: Queue.Queue<ParsedFile>
    skippedParsed: (rp: string) => ParsedFile
    skippedRef: Ref.Ref<number>
    skippedTooLargeParseRef: Ref.Ref<number>
    skippedMinifiedRef: Ref.Ref<number>
    skippedArtifactRef: Ref.Ref<number>
    skippedReadErrorRef: Ref.Ref<number>
    skippedParseFailureRef: Ref.Ref<number>
    skippedCachedRef: Ref.Ref<number>
    cancelled: Ref.Ref<boolean>
    currentlyParsingRef: Ref.Ref<string | undefined>
    progressCounter: Ref.Ref<number>
    treeCacheRef: Ref.Ref<Map<string, Tree>>
    // Phase 2: fileIDs that hit the content-hash cache in this build.
    // After the drain loop we batch-update `indexed_at` on these so any
    // downstream consumer that compares mtime to indexed_at doesn't get
    // stuck on a cached file forever.
    cachedFileIDsRef: Ref.Ref<Set<string>>
    existingFilesByPath: ReadonlyMap<string, CodegraphFile>
  },
): Effect.Effect<void, never, never> => {
  return Effect.gen(function* () {
    yield* Ref.set(cfg.currentlyParsingRef, relativePath)
    if (yield* Ref.get(cfg.cancelled)) {
      yield* Queue.offer(cfg.parsedQueue, cfg.skippedParsed(relativePath))
      return
    }

    const filePath = candidate.path
    const ext = path.extname(filePath).toLowerCase()
    const existing = cfg.existingFilesByPath.get(filePath)
    if (
      existing &&
      !cfg.input.force &&
      existing.sizeBytes === candidate.sizeBytes &&
      existing.mtimeMs === candidate.mtimeMs
    ) {
      yield* Ref.update(cfg.skippedRef, (n) => n + 1)
      yield* Ref.update(cfg.skippedCachedRef, (n) => n + 1)
      yield* Ref.update(cfg.cachedFileIDsRef, (s) => {
        if (s.has(existing.id)) return s
        const next = new Set(s)
        next.add(existing.id)
        return next
      })
      yield* Queue.offer(cfg.parsedQueue, cfg.skippedParsed(relativePath))
      return
    }

    const content = yield* fs.readFileStringSafe(filePath)
    if (content === undefined) {
      yield* Ref.update(cfg.skippedRef, (n) => n + 1)
      yield* Ref.update(cfg.skippedReadErrorRef, (n) => n + 1)
      yield* Queue.offer(cfg.parsedQueue, cfg.skippedParsed(relativePath))
      return
    }

    if (content.length > cfg.maxFileSizeBytes) {
      yield* Effect.logWarning(`Skipping large file (potential bundle): ${relativePath} (${content.length} chars, limit: ${cfg.maxFileSizeBytes})`)
      yield* Ref.update(cfg.skippedRef, (n) => n + 1)
      yield* Ref.update(cfg.skippedTooLargeParseRef, (n) => n + 1)
      yield* Queue.offer(cfg.parsedQueue, cfg.skippedParsed(relativePath))
      return
    }

    const contentHash = hashContent(content)
    if (existing && existing.contentHash === contentHash && !cfg.input.force) {
      yield* Ref.update(cfg.skippedRef, (n) => n + 1)
      yield* Ref.update(cfg.skippedCachedRef, (n) => n + 1)
      // Phase 2: track cached fileIDs so the drain loop can refresh
      // `indexed_at` in one batched UPDATE after the parse pass.
      yield* Ref.update(cfg.cachedFileIDsRef, (s) => {
        if (s.has(existing.id)) return s
        const next = new Set(s)
        next.add(existing.id)
        return next
      })
      yield* Queue.offer(cfg.parsedQueue, cfg.skippedParsed(relativePath))
      return
    }

    if (content.split("\n").some((line) => line.length > 5000)) {
      yield* Effect.logWarning(`Skipping minified/compiled file: ${relativePath}`)
      yield* Ref.update(cfg.skippedRef, (n) => n + 1)
      yield* Ref.update(cfg.skippedMinifiedRef, (n) => n + 1)
      yield* Queue.offer(cfg.parsedQueue, cfg.skippedParsed(relativePath))
      return
    }

    const baseForArtifact = path.basename(filePath).toLowerCase()
    const normPathForArtifact = filePath.replace(/\\/g, "/")
    const isArtifact =
      (normPathForArtifact.endsWith("package.json") ||
        normPathForArtifact.endsWith("dockerfile") ||
        normPathForArtifact.includes("dockerfile.") ||
        normPathForArtifact.endsWith(".dockerfile") ||
        normPathForArtifact.endsWith("compose.yml") ||
        normPathForArtifact.endsWith("compose.yaml") ||
        normPathForArtifact.endsWith("docker-compose.yml") ||
        normPathForArtifact.endsWith("docker-compose.yaml") ||
        normPathForArtifact.endsWith("jenkinsfile") ||
        normPathForArtifact.endsWith(".gitlab-ci.yml") ||
        (normPathForArtifact.includes("azure-pipelines") && normPathForArtifact.endsWith(".yml")) ||
        (baseForArtifact.startsWith("tsconfig") && baseForArtifact.endsWith(".json")) ||
        normPathForArtifact.endsWith("pnpm-workspace.yaml") ||
        normPathForArtifact.endsWith("pnpm-workspace.yml") ||
        normPathForArtifact.endsWith("pyproject.toml") ||
        normPathForArtifact.endsWith("cargo.toml") ||
        normPathForArtifact.endsWith("go.mod") ||
        normPathForArtifact.endsWith(".envrc") ||
        normPathForArtifact.endsWith(".env.example") ||
        baseForArtifact.startsWith(".env") ||
        baseForArtifact.startsWith("dotenv") ||
        /\/\.github\/workflows\/.+\.(yml|yaml)$/i.test(normPathForArtifact) ||
        /\/\.circleci\/.+\.(yml|yaml)$/i.test(normPathForArtifact) ||
        /\.config\.(json|js|ts)$/i.test(baseForArtifact) ||
        baseForArtifact === "config.json") &&
      baseForArtifact !== "dockerfile" &&
      !baseForArtifact.startsWith("dockerfile.") &&
      !baseForArtifact.endsWith(".dockerfile")
    const fileKind = classifyFileKind(filePath, content)
    if (isArtifact && !fileKind) {
      yield* Ref.update(cfg.skippedRef, (n) => n + 1)
      yield* Ref.update(cfg.skippedArtifactRef, (n) => n + 1)
      yield* Queue.offer(cfg.parsedQueue, cfg.skippedParsed(relativePath))
      return
    }

    const parser = getParserForPath(filePath)
    const fileID = existing?.id ?? randomUUID()
    let result: ParseResult
    let newTree: Tree | undefined
    if (isArtifact) {
      result = { nodes: [], edges: [], imports: [] }
    } else if (TS_LIKE_EXTS.has(ext)) {
      const cached = yield* Ref.get(cfg.treeCacheRef)
      const oldTree: Tree | undefined = cached.get(filePath)
      const incr = yield* parseTypeScriptWithTreeSitterIncremental(content, fileID, oldTree)
      result = incr.result
      newTree = incr.tree
      const capturedTree: Tree | undefined = newTree
      if (capturedTree) {
        yield* Ref.update(cfg.treeCacheRef, (m) => {
          m.set(filePath, capturedTree)
          return m
        })
        yield* pruneTreeCache()
      }
    } else if (PY_LIKE_EXTS.has(ext)) {
      const cached = yield* Ref.get(cfg.treeCacheRef)
      const oldTree: Tree | undefined = cached.get(filePath)
      const incr = yield* parsePythonWithTreeSitterIncremental(content, fileID, oldTree)
      result = incr.result
      newTree = incr.tree
      const capturedTree: Tree | undefined = newTree
      if (capturedTree) {
        yield* Ref.update(cfg.treeCacheRef, (m) => {
          m.set(filePath, capturedTree)
          return m
        })
        yield* pruneTreeCache()
      }
    } else {
      result = parser.parse(content, filePath)
    }
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

    const indexedAt = Date.now()
    const file: CodegraphFile = {
      id: fileID,
      path: filePath,
      contentHash,
      language,
      indexedAt,
      sizeBytes: candidate.sizeBytes,
      mtimeMs: candidate.mtimeMs,
    }
    const fileLevelNode: CodegraphNode = {
      id: `${fileID}:file`,
      fileID,
      kind: "file",
      name: path.basename(filePath),
      signature: relativePath,
      startLine: 1,
      endLine: content.split("\n").length,
      code: content.slice(0, 4000),
      derivation: "regex-v1",
    }
    const nodes: CodegraphNode[] = [fileLevelNode, ...result.nodes.map((n) => {
      const node: CodegraphNode = {
        id: n.id,
        fileID,
        kind: n.kind,
        name: n.name,
        signature: n.signature,
        startLine: n.startLine,
        endLine: n.endLine,
        code: n.code,
        derivation: "regex-v1",
      }
      return Object.assign(node, {
        isEntrypoint: isEntrypointNode(node, filePath) ? 1 : 0,
      }) as CodegraphNode
    })]

    const knownNodeIDs = new Set(nodes.map((n) => n.id))
    const edges: CodegraphEdge[] = result.edges
      .filter((e) => knownNodeIDs.has(e.fromNodeID) && knownNodeIDs.has(e.toNodeID))
      .map((e) => ({
        id: e.id,
        fromNodeID: e.fromNodeID,
        toNodeID: e.toNodeID,
        kind: e.kind,
      }))

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
        derivation: "regex-v1",
      })
    }

    yield* Queue.offer(cfg.parsedQueue, {
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
        const prettyCause = Cause.pretty(cause)
        yield* Effect.logWarning(`Failed to index file: ${relativePath}`, { cause: prettyCause })
        yield* repo
          .recordParseError({ path: relativePath, cause: prettyCause, indexedAt: Date.now() })
          .pipe(
            Effect.catchCause((innerCause) =>
              Effect.logWarning(`recordParseError insert failed for ${relativePath}`, { cause: Cause.pretty(innerCause) }),
            ),
          )
        yield* Ref.update(cfg.skippedRef, (n) => n + 1)
        yield* Ref.update(cfg.skippedParseFailureRef, (n) => n + 1)
        yield* Queue.offer(cfg.parsedQueue, cfg.skippedParsed(relativePath))
      }),
    ),
    Effect.ensuring(
      Effect.gen(function* () {
        const doneCount = yield* Ref.updateAndGet(cfg.progressCounter, (n) => n + 1)
        const currentFile = yield* Ref.get(cfg.currentlyParsingRef)
        if (cfg.input.onProgress) {
          yield* cfg.input.onProgress({ file: relativePath, done: doneCount, total: cfg.total, currentFile })
        }
      }),
    ),
  )
}

const rebuildDerivedGraph = Effect.fn("CodegraphIndexer.rebuildDerivedGraph")(function* (
  changedFileIDs: string[] | undefined,
  additionalSourceFileIDs?: readonly string[],
) {
  const isCancelled = yield* Ref.get(cancelled)
  if (isCancelled) return

  const changedSet = changedFileIDs && changedFileIDs.length > 0 ? new Set(changedFileIDs) : null
  const sourceFileIDs = new Set<string>([
    ...(changedFileIDs ?? []),
    ...(additionalSourceFileIDs ?? []),
  ])
  const sourceSet = sourceFileIDs.size > 0 ? sourceFileIDs : null

  // For incremental mode, fetch source nodes WITH code and all other nodes
  // WITHOUT code. The source set includes dependents so their persisted code
  // can regenerate edges after a changed endpoint is replaced.
  // For full rebuild, fetch everything with code (existing path).
  let allNodesForIndex: CodegraphNode[]

  if (sourceSet && sourceSet.size > 0) {
    const [sourceNodes, lightNodes] = yield* Effect.all([
      repo.nodesByFileIDs({ fileIDs: [...sourceSet] }),
      repo.searchNodesLight({ limit: 100_000 }),
    ])
    const sourceIDs = new Set(sourceNodes.map((n) => n.id))
    // lightNodes already have no `code` field; spread to lose the Omit type
    allNodesForIndex = [
      ...sourceNodes,
      ...lightNodes.filter((n) => !sourceIDs.has(n.id)),
    ]
  } else {
    // Full rebuild
    allNodesForIndex = yield* repo.searchNodes({ limit: 100_000 })
  }

  const allFiles = yield* repo.listAllFiles()
  const fileByID = new Map(allFiles.map((f) => [f.id, f]))
  const fileDir = (filePath: string) => path.dirname(filePath).replace(/\\/g, "/")

  const nodeMap = new Map<string, CodegraphNode[]>()
  const nodeByID = new Map<string, CodegraphNode>()
  const nodesByFileID = new Map<string, CodegraphNode[]>()
  const BATCH_SIZE = 500

  for (let batchStart = 0; batchStart < allNodesForIndex.length; batchStart += BATCH_SIZE) {
    if (yield* Ref.get(cancelled)) break
    const batchEnd = Math.min(batchStart + BATCH_SIZE, allNodesForIndex.length)
    const batch = allNodesForIndex.slice(batchStart, batchEnd)

    for (const node of batch) {
      const list = nodeMap.get(node.name) ?? []
      list.push(node)
      nodeMap.set(node.name, list)
      nodeByID.set(node.id, node)
      const fileList = nodesByFileID.get(node.fileID) ?? []
      fileList.push(node)
      nodesByFileID.set(node.fileID, fileList)
    }
  }

  const fileByPath = new Map(allFiles.map((f) => [f.path.replace(/\\/g, "/"), f]))
  const deriveModuleCandidates = (sourcePath: string, specifier: string): ReadonlyArray<CodegraphFile> => {
    if (!specifier) return []
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) return []
    const sourceDir = path.dirname(sourcePath)
    const resolvedBase = path.resolve(sourceDir, specifier).replace(/\\/g, "/")
    const direct = fileByPath.get(resolvedBase)
    if (direct) return [direct]
    const candidates = [
      `${resolvedBase}.ts`,
      `${resolvedBase}.tsx`,
      `${resolvedBase}.js`,
      `${resolvedBase}.jsx`,
      `${resolvedBase}.mts`,
      `${resolvedBase}.cts`,
      `${resolvedBase}.mjs`,
      `${resolvedBase}.cjs`,
      `${resolvedBase}.py`,
      `${resolvedBase}.pyw`,
      `${resolvedBase}/index.ts`,
      `${resolvedBase}/index.tsx`,
      `${resolvedBase}/index.js`,
      `${resolvedBase}/index.jsx`,
      `${resolvedBase}/index.mts`,
      `${resolvedBase}/index.cts`,
      `${resolvedBase}/index.py`,
    ]
    return candidates
      .map((candidate) => fileByPath.get(candidate))
      .filter((file): file is CodegraphFile => file !== undefined)
  }

  const referenceEdges: { fromNodeID: string; toNodeID: string; kind: "imports" | "calls" | "extends" | "references" }[] = []
  const crossEdges: { fromNodeID: string; toNodeID: string; kind: CodegraphEdge["kind"] }[] = []
  const referenceEdgeKeys = new Set<string>()

  // For referenceEdges: iterate only nodes that have code and are NOT skipped kinds.
  // In incremental mode, iterate changed files plus dependent files as edge sources.
  const importScopesByFileID = new Map<string, Set<string>>()
  for (const [fileID, nodes] of nodesByFileID) {
    const fileNode = nodes.find((node) => node.kind === "file")
    const owner = fileByID.get(fileID)
    if (!fileNode?.code || !owner) continue
    const scope = new Set<string>()
    for (const match of fileNode.code.matchAll(/import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?["']([^"']+)["']/g)) {
      const specifier = match[1]
      if (!specifier) continue
      const importedFiles = deriveModuleCandidates(owner.path, specifier)
      for (const imported of importedFiles) {
        const importedNodes = nodesByFileID.get(imported.id) ?? []
        for (const node of importedNodes) {
          if (node.kind === "file") continue
          scope.add(node.id)
        }
      }
    }
    importScopesByFileID.set(fileID, scope)
  }

  for (const nodeA of allNodesForIndex) {
    if (
      !nodeA.code ||
      nodeA.kind === "test" ||
      nodeA.kind === "route" ||
      nodeA.kind === "config" ||
      nodeA.kind === "build" ||
      nodeA.kind === "package" ||
      nodeA.kind === "generated" ||
      nodeA.kind === "ci" ||
      nodeA.kind === "docker" ||
      nodeA.kind === "env" ||
      nodeA.kind === "doc" ||
      nodeA.kind === "file"
    ) {
      continue
    }

    // Incremental: skip nodeA if its file is neither changed nor a dependent source
    if (sourceSet && !sourceSet.has(nodeA.fileID)) continue

    const inScopeNodeIDs = new Set<string>()
    const sameFileNodes = nodesByFileID.get(nodeA.fileID) ?? []
    for (const n of sameFileNodes) {
      if (n.id !== nodeA.id && n.kind !== "file") inScopeNodeIDs.add(n.id)
    }
    const importedScope = importScopesByFileID.get(nodeA.fileID)
    if (importedScope) {
      for (const importedID of importedScope) inScopeNodeIDs.add(importedID)
    }
    if (!importedScope || importedScope.size === 0) {
      const owner = fileByID.get(nodeA.fileID)
      if (owner) {
        const ownerDir = fileDir(owner.path)
        for (const file of allFiles) {
          if (file.id === owner.id || fileDir(file.path) !== ownerDir) continue
          const peerNodes = nodesByFileID.get(file.id) ?? []
          for (const node of peerNodes) {
            if (node.kind !== "file") inScopeNodeIDs.add(node.id)
          }
        }
      }
    }
    const inScopeByName = new Map<string, CodegraphNode[]>()
    for (const nodeID of inScopeNodeIDs) {
      const scopedNode = nodeByID.get(nodeID)
      if (!scopedNode) continue
      const scoped = inScopeByName.get(scopedNode.name) ?? []
      scoped.push(scopedNode)
      inScopeByName.set(scopedNode.name, scoped)
    }
    const identifiers = new Set<string>()
    for (const m of nodeA.code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
      if (m[0].length >= 3 && inScopeByName.has(m[0])) identifiers.add(m[0])
    }

    for (const name of identifiers) {
      const targets = inScopeByName.get(name)
      if (!targets || targets.length === 0) continue

      for (const nodeB of targets) {
        if (nodeB.id === nodeA.id) continue

        const kind =
          nodeA.kind === "class" && nodeA.code.includes(`extends ${name}`)
            ? ("extends" as const)
            : nodeA.code.includes(`${name}(`)
              ? ("calls" as const)
              : ("references" as const)

        const key = `${nodeA.id}->${nodeB.id}:${kind}`
        if (referenceEdgeKeys.has(key)) continue
        referenceEdgeKeys.add(key)
        referenceEdges.push({
          fromNodeID: nodeA.id,
          toNodeID: nodeB.id,
          kind,
        })
      }
    }
  }

  // Filter node lists by file set for crossEdges that are scope-limited to changed/dependent files.
  // In incremental mode, changed and dependent source files are processed.
  // In full mode, all nodes are processed (sourceSet is null).
  const configNodes = allNodesForIndex.filter((n) => n.kind === "config" && (!sourceSet || sourceSet.has(n.fileID)))
  const dockerNodes = allNodesForIndex.filter((n) => n.kind === "docker")
  const testNodes = allNodesForIndex.filter((n) => n.kind === "test" && (!sourceSet || sourceSet.has(n.fileID)))
  const routeNodes = allNodesForIndex.filter((n) => n.kind === "route" && (!sourceSet || sourceSet.has(n.fileID)))
  const generatedNodes = allNodesForIndex.filter((n) => n.kind === "generated" && (!sourceSet || sourceSet.has(n.fileID)))

  for (const testNode of testNodes) {
    if (yield* Ref.get(cancelled)) {
      yield* Effect.logWarning("codegraph: cancelled during tested_by")
      break
    }
    const testFile = fileByID.get(testNode.fileID)
    if (!testFile || !testNode.code) continue
    const testFileImports = extractTestFileImports(testNode.code)
    const referenced = new Set<string>()
    for (const m of testNode.code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
      referenced.add(m[0])
    }
    for (const name of referenced) {
      const candidates = nodeMap.get(name)
      if (!candidates || candidates.length > 10) continue
      for (const node of candidates) {
        if (node.fileID === testNode.fileID) continue
        if (node.kind === "test") continue
        const nodeFile = fileByID.get(node.fileID)
        if (!nodeFile) continue
        if (/\.(test|spec)\./i.test(nodeFile.path.toLowerCase())) continue

        const targetImport = nodeFile.path.replace(/\.(ts|tsx|js|jsx)$/, "").replace(/^.*\//, "")
        const importsFile = testFileImports.has(targetImport)

        const callOnlyMatch = !importsFile &&
          candidates.length === 1 &&
          (testNode.code ?? "").includes(`${name}(`)

        if (importsFile || callOnlyMatch) {
          crossEdges.push({ fromNodeID: node.id, toNodeID: testNode.id, kind: "tested_by" })
        }
      }
    }
  }

  for (const cfg of configNodes) {
    if (yield* Ref.get(cancelled)) {
      yield* Effect.logWarning("codegraph: cancelled during configured_by")
      break
    }
    const cfgFile = fileByID.get(cfg.fileID)
    if (!cfgFile) continue
    const cfgDir = fileDir(cfgFile.path)
    const cfgBasename = cfgFile.path.replace(/\\/g, "/").split("/").pop() ?? cfgFile.path
    for (const file of allFiles) {
      if (fileDir(file.path) !== cfgDir) continue
      if (file.id === cfg.fileID) continue
      const fromNodes = nodesByFileID.get(file.id) ?? []
      const fromNode = fromNodes.find(
        (n) =>
          n.kind !== "config" &&
          n.kind !== "docker" &&
          n.kind !== "package" &&
          n.kind !== "build" &&
          n.kind !== "ci" &&
          n.kind !== "env" &&
          n.kind !== "doc" &&
          n.kind !== "test" &&
          n.kind !== "route" &&
          n.kind !== "generated",
      ) ?? fromNodes[0]
      if (!fromNode) continue
      const code = fromNode.code ?? ""
      if (!code.includes(cfgBasename)) continue
      crossEdges.push({ fromNodeID: fromNode.id, toNodeID: cfg.id, kind: "configured_by" })
    }
  }

  for (const cfg of configNodes) {
    const cfgFile = fileByID.get(cfg.fileID)
    if (!cfgFile) continue
    const cfgDir = fileDir(cfgFile.path)
    const docker = dockerNodes.find((n) => {
      const f = fileByID.get(n.fileID)
      return f ? fileDir(f.path) === cfgDir : false
    })
    if (docker) crossEdges.push({ fromNodeID: cfg.id, toNodeID: docker.id, kind: "built_by" })
  }

  if (yield* Ref.get(cancelled)) {
    yield* Effect.logWarning("codegraph: cancelled before mounts")
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
  const touchedNodeIDs = new Set<string>()
  for (const edge of edgesToWrite) {
    touchedNodeIDs.add(edge.fromNodeID)
    touchedNodeIDs.add(edge.toNodeID)
  }
  if (changedSet) {
    const deletedTouched = yield* repo.deleteDerivedEdgesForFiles({ fileIDs: changedFileIDs! })
    for (const nodeID of deletedTouched) touchedNodeIDs.add(nodeID)
  } else {
    // Full-rebuild derived-edge purge. Pre-Phase-3a rebuilds inserted with
    // onConflictDoNothing without ever deleting, which let stale derived edges
    // accumulate across builds (~166K stale edges on this repo before the fix).
    // Deleting them here and re-inserting via putEdges gives a reproducible
    // import-scoped count.
    const deletedTouchedFull = yield* repo.deleteAllDerivedEdges()
    for (const nodeID of deletedTouchedFull) touchedNodeIDs.add(nodeID)
  }
  if (edgesToWrite.length > 0) {
    yield* repo.putEdges(edgesToWrite)
  }
  if (touchedNodeIDs.size > 0) {
    yield* repo.recomputeInDegree({ nodeIDs: [...touchedNodeIDs] }).pipe(Effect.orDie)
  } else if (!changedSet) {
    // Full-rebuild purge may have driven in-degree to zero on many nodes that
    // were never re-touched by the new derived pass. Recompute over the whole
    // graph so downstream readers see accurate ranker scores.
    yield* repo.recomputeInDegree().pipe(Effect.orDie)
  }
})

    const index = Effect.fn("CodegraphIndexer.index")(function* (input: {
      root: string
      force?: boolean
      maxFileSizeBytes?: number
      excludePatterns?: readonly string[]
      onProgress?: (info: { file: string; done: number; total: number; currentFile?: string }) => Effect.Effect<void>
    }) {
      yield* Ref.set(cancelled, false)
      const maxFileSizeBytes = input.maxFileSizeBytes ?? 1_048_576
      const { gitignore, banyanignore } = yield* loadIgnorePatterns(input.root, input.excludePatterns)
      const walkResult = yield* walkDirectory(input.root, maxFileSizeBytes, input.root, gitignore, banyanignore)
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
        const normPath = filePath.replace(/\\/g, "/")
        if (lower === "package.json") return true
        if (lower === "dockerfile" || lower.startsWith("dockerfile.") || lower.endsWith(".dockerfile")) return true
        if (lower === "compose.yml" || lower === "compose.yaml") return true
        if (lower === "docker-compose.yml" || lower === "docker-compose.yaml") return true
        if (lower === "jenkinsfile") return true
        if (lower === ".gitlab-ci.yml") return true
        if (lower.startsWith("azure-pipelines") && lower.endsWith(".yml")) return true
        if (lower.startsWith("tsconfig") && lower.endsWith(".json")) return true
        if (lower === "pnpm-workspace.yaml" || lower === "pnpm-workspace.yml") return true
        if (lower === "pyproject.toml") return true
        if (lower === "cargo.toml") return true
        if (lower === "go.mod") return true
        if (lower === ".envrc" || lower === ".env.example") return true
        if (lower.startsWith(".env")) return true
        if (lower.startsWith("dotenv")) return true
        if (/\/\.github\/workflows\/.+\.(yml|yaml)$/i.test(normPath)) return true
        if (/\/\.circleci\/.+\.(yml|yaml)$/i.test(normPath)) return true
        if (/\.config\.(json|js|ts)$/i.test(base)) return true
        if (lower === "config.json") return true
        return false
      }
      const codeFiles = allFiles.filter((f) => {
        const ext = path.extname(f.path).toLowerCase()
        return codeExtensions.has(ext) || isArtifactPath(f.path)
      })
      const existingFilesByPath = new Map((yield* repo.listAllFiles()).map((f) => [f.path, f]))

      const indexedRef = yield* Ref.make(0)
      const skippedRef = yield* Ref.make(0)
      const symbolsIndexedRef = yield* Ref.make(0)
      const skippedGitignoredRef = yield* Ref.make(walkResult.skippedByGitignore)
      const skippedBanyanignoredRef = yield* Ref.make(walkResult.skippedByBanyanignore)
      const skippedArtifactRef = yield* Ref.make(0)
      const skippedTooLargeRef = yield* Ref.make(walkResult.skippedBySize)
      const skippedTooLargeParseRef = yield* Ref.make(0)
      const skippedMinifiedRef = yield* Ref.make(0)
      const skippedCachedRef = yield* Ref.make(0)
      const skippedReadErrorRef = yield* Ref.make(0)
      const skippedParseFailureRef = yield* Ref.make(0)
      const total = codeFiles.length
      const progressCounter = yield* Ref.make(0)
      const currentlyParsingRef = yield* Ref.make<string | undefined>(undefined)
      // Phase 2: fileIDs that hit the cache this build. After the drain
      // loop completes we batch-write `indexed_at = now` so the next
      // run's ready-check sees a fresh timestamp and doesn't keep
      // tripping on files whose content is unchanged.
      const cachedFileIDsRef = yield* Ref.make<Set<string>>(new Set())

      if (input.onProgress) {
        yield* input.onProgress({ file: "", done: 0, total })
      }

      const parsedQueue = yield* Queue.bounded<ParsedFile>(128)
      const skippedParsed = (relativePath: string): ParsedFile => ({
        file: { id: "", path: "", contentHash: "", language: "", indexedAt: 0 },
        nodes: [],
        edges: [],
        relativePath,
        skipped: true,
      })

      const parseFiber = (candidate: CandidateFile): Effect.Effect<void, never, never> => {
        const relativePath = path.relative(input.root, candidate.path).replace(/\\/g, "/")
        return indexCandidateFileCore(candidate, relativePath, {
          input,
          maxFileSizeBytes,
          total,
          parsedQueue,
          skippedParsed,
          skippedRef,
          skippedTooLargeParseRef,
          skippedMinifiedRef,
          skippedArtifactRef,
          skippedReadErrorRef,
          skippedParseFailureRef,
          skippedCachedRef,
          cancelled,
          currentlyParsingRef,
          progressCounter,
          treeCacheRef,
          cachedFileIDsRef,
          existingFilesByPath,
        })
      }

      const drainParsedQueue = Effect.gen(function* () {
        let processed = 0
        while (processed < total) {
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
                yield* repo
                  .recordParseError({ path: parsed.relativePath, cause: Cause.pretty(cause), indexedAt: Date.now() })
                  .pipe(
                    Effect.catchCause((innerCause) =>
                      Effect.logWarning(`recordParseError insert failed for ${parsed.relativePath}`, {
                        cause: Cause.pretty(innerCause),
                      }),
                    ),
                  )
                yield* Ref.update(skippedRef, (n) => n + 1)
                yield* Ref.update(skippedParseFailureRef, (n) => n + 1)
              }),
            ),
          )
          if (parsed.nodes.length > 0) {
            yield* Ref.update(indexedRef, (n) => n + 1)
            yield* Ref.update(symbolsIndexedRef, (n) => n + parsed.nodes.length)
          }
          if (processed % CHECKPOINT_EVERY === 0) {
            yield* database.db.run("PRAGMA wal_checkpoint(PASSIVE)").pipe(Effect.ignore)
          }
        }
      })

      yield* Effect.all(
        [
          Effect.forEach(codeFiles, parseFiber, { concurrency: 8, discard: true }),
          drainParsedQueue,
        ],
        { concurrency: 2, discard: true },
      ).pipe(Effect.ensuring(Queue.shutdown(parsedQueue)))
      yield* database.db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.ignore)

      // Phase 3: prune files that disappeared between walks. Before this,
      // a `full rebuild` left orphan rows in `codegraph_files` and their
      // edges + nodes behind, inflating `totalFiles` and the `totalEdges`
      // baseline in `meta`. The diff is `existingFilesByPath - walked`.
      const walkedPaths = new Set(allFiles.map((f) => f.path))
      const orphanFileRows: Array<{ id: string; path: string }> = []
      for (const [path, row] of existingFilesByPath) {
        if (!walkedPaths.has(path)) orphanFileRows.push({ id: row.id, path })
      }
      for (const orphan of orphanFileRows) {
        yield* repo.deleteFile(orphan.id).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`Pruning orphaned file row failed for ${orphan.path}`, {
              cause: Cause.pretty(cause),
            }),
          ),
        )
      }

      // Phase 2: refresh `indexed_at` on every file that hit the content
      // cache in this build. One batched update per 900-id chunk —
      // cheaper than touching each row in the drain loop and, more
      // importantly, fixes the readiness trap where a cached file's
      // never-refreshed timestamp made it look "changed" forever.
      const cachedFileIDs = yield* Ref.get(cachedFileIDsRef)
      if (cachedFileIDs.size > 0) {
        yield* repo.bumpIndexedAt({ fileIDs: [...cachedFileIDs], indexedAt: Date.now() }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("bumpIndexedAt failed; cached files may look stale until next build", {
              cause: Cause.pretty(cause),
            }),
          ),
        )
      }

      const indexed = yield* Ref.get(indexedRef)
      if (indexed > 0) {
        yield* rebuildDerivedGraph(undefined)
      }
      const skipped = yield* Ref.get(skippedRef)
      const symbolsIndexed = yield* Ref.get(symbolsIndexedRef)
      const skippedGitignored = yield* Ref.get(skippedGitignoredRef)
      const skippedBanyanignored = yield* Ref.get(skippedBanyanignoredRef)
      const skippedArtifact = yield* Ref.get(skippedArtifactRef)
      const skippedTooLarge = yield* Ref.get(skippedTooLargeRef)
      const skippedTooLargeParse = yield* Ref.get(skippedTooLargeParseRef)
      const skippedMinified = yield* Ref.get(skippedMinifiedRef)
      const skippedCached = yield* Ref.get(skippedCachedRef)
      const skippedReadError = yield* Ref.get(skippedReadErrorRef)
      const skippedParseFailure = yield* Ref.get(skippedParseFailureRef)

      const totalSkipped =
        skippedGitignored +
        skippedBanyanignored +
        skippedArtifact +
        skippedTooLarge +
        skippedTooLargeParse +
        skippedMinified +
        skippedCached +
        skippedReadError +
        skippedParseFailure

      const parseErrors = yield* repo.listParseErrors()

      // Phase 2: eligibleFiles is the graphCoverage denominator. It counts
      // only files the indexer would actually attempt: code/artifact
      // candidates the walker reached, plus code candidates excluded
      // only by the size budget (which is ours, not the repo's).
      // Non-code files (`.json`, `.lock`, images, fonts, etc.) are
      // excluded because the indexer will never emit a graph row for
      // them — counting them capped coverage on monorepos and brought it
      // close to the 0.5 staleness cliff.
      const eligibleFiles = codeFiles.length + walkResult.skippedBySize

      return {
        indexed,
        skipped: totalSkipped,
        scannedFiles: indexed + totalSkipped,
        eligibleFiles,
        symbolsIndexed,
        skippedByReason: {
          gitignored: skippedGitignored,
          banyanignored: skippedBanyanignored,
          artifact: skippedArtifact,
          tooLarge: skippedTooLarge,
          minified: skippedMinified,
          tooLargeParse: skippedTooLargeParse,
          cached: skippedCached,
          readError: skippedReadError,
          parseFailure: skippedParseFailure,
        },
        parseErrors: parseErrors.slice(0, 50),
      }
    })

    const cancel = Effect.fn("CodegraphIndexer.cancel")(function* () {
      yield* Ref.set(cancelled, true)
    })

    const applyChanges = Effect.fn("CodegraphIndexer.applyChanges")(function* (input: {
      root: string
      addedOrChanged: string[]
      removed: string[]
      force?: boolean
      maxFileSizeBytes?: number
      excludePatterns?: readonly string[]
      onProgress?: (info: { file: string; done: number; total: number; currentFile?: string }) => Effect.Effect<void>
    }) {
      yield* Ref.set(cancelled, false)
      const maxFileSizeBytes = input.maxFileSizeBytes ?? 1_048_576
      const { gitignore, banyanignore } = yield* loadIgnorePatterns(input.root, input.excludePatterns)
      const removedFileIDs = new Set<string>()
      const filteredRemoved: string[] = []
      const filteredAddedOrChanged: CandidateFile[] = []
      let skippedInputs = 0
      const existingFilesByPath = new Map((yield* repo.listAllFiles()).map((f) => [f.path, f]))

      // Capture the pre-mutation file IDs before delete/write cascades remove
      // their endpoint nodes and edges. This lets removed and replaced files
      // contribute their existing dependents to the later source rebuild.
      const dependencySeedFileIDs = new Set<string>()
      for (const filePath of new Set([...input.removed, ...input.addedOrChanged])) {
        const existing = existingFilesByPath.get(filePath)
        if (existing) dependencySeedFileIDs.add(existing.id)
      }
      const dependentFileIDs = dependencySeedFileIDs.size > 0
        ? yield* repo.dependentsOfFiles({ fileIDs: [...dependencySeedFileIDs] })
        : []

      for (const filePath of input.removed) {
        if (isIgnoredByPatterns(gitignore, input.root, filePath) || isIgnoredByPatterns(banyanignore, input.root, filePath)) {
          const existing = existingFilesByPath.get(filePath)
          if (existing) {
            removedFileIDs.add(existing.id)
            yield* repo.deleteFile(existing.id)
            existingFilesByPath.delete(filePath)
          }
          yield* dropTreeCacheFor(filePath)
          skippedInputs++
          continue
        }
        filteredRemoved.push(filePath)
      }

      let removed = 0
      for (const filePath of filteredRemoved) {
        const existing = existingFilesByPath.get(filePath)
        if (existing) {
          removedFileIDs.add(existing.id)
          yield* repo.deleteFile(existing.id)
          existingFilesByPath.delete(filePath)
          removed++
        } else {
          skippedInputs++
        }
        yield* dropTreeCacheFor(filePath)
      }

      for (const filePath of input.addedOrChanged) {
        const relativePath = path.relative(input.root, filePath).replace(/\\/g, "/")
        if (isIgnoredByPatterns(gitignore, input.root, filePath) || isIgnoredByPatterns(banyanignore, input.root, filePath)) {
          const existing = existingFilesByPath.get(filePath)
          if (existing) {
            removedFileIDs.add(existing.id)
            yield* repo.deleteFile(existing.id)
            existingFilesByPath.delete(filePath)
          }
          yield* dropTreeCacheFor(filePath)
          skippedInputs++
          continue
        }
        const stats = yield* fs.stat(filePath).pipe(Effect.orDie)
        if (stats.size > maxFileSizeBytes) {
          yield* Effect.logWarning(`Skipping large file (potential bundle): ${relativePath} (${stats.size} bytes, limit: ${maxFileSizeBytes})`)
          const existing = existingFilesByPath.get(filePath)
          if (existing) {
            removedFileIDs.add(existing.id)
            yield* repo.deleteFile(existing.id)
            existingFilesByPath.delete(filePath)
          }
          yield* dropTreeCacheFor(filePath)
          skippedInputs++
          continue
        }
        filteredAddedOrChanged.push({
          path: filePath,
          sizeBytes: Number(stats.size),
          mtimeMs: "value" in stats.mtime ? Math.floor(stats.mtime.value.getTime()) : 0,
        })
      }

      if (filteredRemoved.length === 0 && filteredAddedOrChanged.length === 0 && removedFileIDs.size === 0) {
        return {
          indexed: 0,
          removed: 0,
          skipped: input.addedOrChanged.length + input.removed.length,
          parseErrors: [],
        }
      }

      const skippedRef = yield* Ref.make(0)
      const skippedTooLargeParseRef = yield* Ref.make(0)
      const skippedMinifiedRef = yield* Ref.make(0)
      const skippedArtifactRef = yield* Ref.make(0)
      const skippedReadErrorRef = yield* Ref.make(0)
      const skippedParseFailureRef = yield* Ref.make(0)
      const skippedCachedRef = yield* Ref.make(0)
      const indexedRef = yield* Ref.make(0)
      const progressCounter = yield* Ref.make(0)
      const currentlyParsingRef = yield* Ref.make<string | undefined>(undefined)
      const changedFileIDsRef = yield* Ref.make<Set<string>>(new Set(removedFileIDs))
      // Phase 2: track fileIDs that hit the content-hash cache in this
      // incremental build so we can refresh `indexed_at` in one batched
      // UPDATE after the drain (see `bumpIndexedAt`).
      const cachedFileIDsRef = yield* Ref.make<Set<string>>(new Set())
      const total = filteredAddedOrChanged.length

      if (input.onProgress) {
        yield* input.onProgress({ file: "", done: 0, total })
      }

      const parsedQueue = yield* Queue.bounded<ParsedFile>(128)
      const skippedParsedFn = (relativePath: string): ParsedFile => ({
        file: { id: "", path: "", contentHash: "", language: "", indexedAt: 0 },
        nodes: [],
        edges: [],
        relativePath,
        skipped: true,
      })

      // Plan Phase 5 fix: run the producer pool and the drain concurrently
// instead of sequentially. The previous code drained only after every
// parse had finished, which deadlocked the bounded queue at 128 entries
// once the input exceeded that cap (the 129-file case).
const drainParsedQueue = Effect.gen(function* () {
        let processed = 0
        while (processed < total) {
          const parsed = yield* Queue.take(parsedQueue)
          processed++
          if (parsed.skipped) continue
          if (parsed.previousFileID) {
            yield* Ref.update(changedFileIDsRef, (s) => {
              s.add(parsed.previousFileID!)
              return s
            })
          }
          if (parsed.file.id) {
            yield* Ref.update(changedFileIDsRef, (s) => {
              s.add(parsed.file.id)
              return s
            })
          }
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
                yield* repo
                  .recordParseError({ path: parsed.relativePath, cause: Cause.pretty(cause), indexedAt: Date.now() })
                  .pipe(
                    Effect.catchCause((innerCause) =>
                      Effect.logWarning(`recordParseError insert failed for ${parsed.relativePath}`, {
                        cause: Cause.pretty(innerCause),
                      }),
                    ),
                  )
                yield* Ref.update(skippedRef, (n) => n + 1)
                yield* Ref.update(skippedParseFailureRef, (n) => n + 1)
              }),
            ),
          )
          if (parsed.nodes.length > 0) {
            yield* Ref.update(indexedRef, (n) => n + 1)
          }
          if (processed % CHECKPOINT_EVERY === 0) {
            yield* database.db.run("PRAGMA wal_checkpoint(PASSIVE)").pipe(Effect.ignore)
          }
        }
      })

      yield* Effect.all(
        [
          Effect.forEach(filteredAddedOrChanged, (candidate) => {
            const relativePath = path.relative(input.root, candidate.path).replace(/\\/g, "/")
            return indexCandidateFileCore(candidate, relativePath, {
              input,
              maxFileSizeBytes,
              total,
              parsedQueue,
              skippedParsed: skippedParsedFn,
              skippedRef,
              skippedTooLargeParseRef,
              skippedMinifiedRef,
              skippedArtifactRef,
              skippedReadErrorRef,
              skippedParseFailureRef,
              skippedCachedRef,
              cancelled,
              currentlyParsingRef,
              progressCounter,
              treeCacheRef,
              cachedFileIDsRef,
              existingFilesByPath,
            })
          }, { concurrency: 8, discard: true }),
          drainParsedQueue,
        ],
        { concurrency: 2, discard: true },
      ).pipe(Effect.ensuring(Queue.shutdown(parsedQueue)))

      yield* database.db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.ignore)

      // Phase 2: refresh `indexed_at` on every file that hit the cache
      // in this incremental build. Same logic as the full-build path —
      // keeps downstream time-based heuristics from getting stuck on
      // cached files.
      const cachedFileIDs = yield* Ref.get(cachedFileIDsRef)
      if (cachedFileIDs.size > 0) {
        yield* repo.bumpIndexedAt({ fileIDs: [...cachedFileIDs], indexedAt: Date.now() }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("bumpIndexedAt failed on incremental; cached files may look stale", {
              cause: Cause.pretty(cause),
            }),
          ),
        )
      }

      const changedFileIDs = Array.from(yield* Ref.get(changedFileIDsRef))
      if (changedFileIDs.length > 0) {
        const changedSet = new Set(changedFileIDs)
        const dependentSourceFileIDs = dependentFileIDs.filter((fileID) => !changedSet.has(fileID))
        yield* rebuildDerivedGraph(changedFileIDs, dependentSourceFileIDs)
      }

      const fileCount = yield* repo.countFiles()
      // Phase 0: the incremental path doesn't run a full directory walk,
      // so the eligible denominator is just the file count from the
      // caller-supplied change set (plus any previously-known files not
      // yet seen by the walker). This keeps coverage comparable to a full
      // build when the change set IS the entire repo.
      const listingCount = filteredAddedOrChanged.length + filteredRemoved.length
      const eligibleForCoverage = listingCount > 0 ? listingCount : fileCount
      if (changedFileIDs.length > 0) {
        yield* repo.bumpVersion({
          eligibleFiles: eligibleForCoverage,
          indexedRoot: input.root,
        })
      }

      const indexed = yield* Ref.get(indexedRef)
      const parsedSkipped = yield* Ref.get(skippedRef)
      const parseErrors = yield* repo.listParseErrors()
      return {
        indexed,
        removed,
        skipped: skippedInputs + parsedSkipped,
        parseErrors: parseErrors.slice(0, 50),
      }
    })

    const indexFiles = Effect.fn("CodegraphIndexer.indexFiles")(function* (input: {
      root: string
      paths: string[]
      force?: boolean
      maxFileSizeBytes?: number
      excludePatterns?: readonly string[]
      onProgress?: (info: { file: string; done: number; total: number; currentFile?: string }) => Effect.Effect<void>
    }) {
      const result = yield* applyChanges({
        root: input.root,
        addedOrChanged: input.paths,
        removed: [],
        ...(input.force !== undefined ? { force: input.force } : {}),
        ...(input.maxFileSizeBytes !== undefined ? { maxFileSizeBytes: input.maxFileSizeBytes } : {}),
        ...(input.excludePatterns !== undefined ? { excludePatterns: input.excludePatterns } : {}),
        ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
      })
      return {
        indexed: result.indexed,
        skipped: result.skipped,
        parseErrors: result.parseErrors,
      }
    })

    const removeFiles = Effect.fn("CodegraphIndexer.removeFiles")(function* (input: {
      root: string
      paths: string[]
    }) {
      yield* applyChanges({
        root: input.root,
        addedOrChanged: [],
        removed: input.paths,
      })
    })

    return Service.of({ index, applyChanges, indexFiles, removeFiles, cancel })
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

// Note: CodegraphRepo.defaultLayer already provides Database.defaultLayer,
// so we don't provide it again here. Tests that need a custom DB path should
// build the layer as `CodegraphIndexer.layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(Database.layerFromPath(...)))`.
export const defaultLayer = layer.pipe(Layer.provide(CodegraphRepo.defaultLayer))
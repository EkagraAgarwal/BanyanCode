export * as CodegraphIndexer from "./codegraph-indexer"

import { Cause, Context, Effect, FileSystem, Layer, Queue, Ref, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import path from "path"
import { FSUtil } from "../fs-util"
import { CodegraphRepo } from "./codegraph-repo"
import { Database } from "../database/database"
import type { CodegraphEdge, CodegraphFile, CodegraphNode, CodegraphNodeKind } from "./types"
import { getParserForPath } from "./langs/registry"
import type { ParseResult } from "./langs/types"
import { parseTypeScript, stripCommentsAndStrings } from "./langs/typescript"
import { parsePython } from "./langs/python"
import { ensureQuerySourcesLoaded } from "./langs/query-executor"
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
  // BanyanCode runtime artifacts left at a workspace root. A *.db is the
  // indexer's own DB (codegraph.sql.ts, memory.sql.ts, subagent-*.sql.ts);
  // *.db-wal / *.db-shm are SQLite sidecars. Always exclude — they are
  // never legitimate source code, and walking them just logs noisy
  // "exceeding size limit" warnings on every build.
  "*.db",
  "*.db-wal",
  "*.db-shm",
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

// Auto-generated SDK output (regenerated by `bun ./packages/sdk/js/script/build.ts`
// via @hey-api/openapi-ts). These directories contain files like
// `types.gen.ts` (~250KB) with single-line `export type Foo = { ... }` declarations
// that exceed 5000 chars on one line. The minified/compiled heuristic at
// codegraph-indexer.ts:488 false-positives on them, and regenerating the SDK
// churns the entire graph on every build. Path-based exclusion is unambiguous
// and cheaper than sniffing each file's header for a `@hey-api/openapi-ts` marker.
const DEFAULT_GENERATED_EXCLUDES = [
  "packages/sdk/js/src/gen",
  "packages/sdk/js/src/v2/gen",
]

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const repo = yield* CodegraphRepo.Service
    const database = yield* Database.Service
    const cancelled = yield* Ref.make(false)

    // Bundle anchor, NOT a parse dependency: query-executor's `.scm` text
    // imports — and transitively tree-sitter.ts's wasm imports — must stay
    // statically reachable from the production graph, because
    // `packages/opencode/script/build.ts` validates that all 7 tree-sitter
    // assets exist in compiled binaries and fails the build otherwise. The
    // indexer no longer parses with tree-sitter (parser edges are
    // structurally discarded; the derived-edge lifecycle in
    // rebuildDerivedGraph owns every surviving edge kind), so this call
    // only primes the module-level query cache for future consumers (e.g.
    // the Wave-5 tree-sitter node-extraction migration). It builds a
    // 3-entry Map from bundled strings — microseconds, memoized per
    // process, no wasm instantiation (that happens only in
    // `ensureWebTreeSitterReady`, which the indexer no longer calls).
    yield* Effect.promise(() => ensureQuerySourcesLoaded())

    const walkDirectory = (
      dir: string,
      maxFileSizeBytes: number,
      root: string,
      gitignorePatterns: string[],
      banyanignorePatterns: string[],
    ): Effect.Effect<{ files: CandidateFile[]; skippedBySize: number; skippedByGitignore: number; skippedByBanyanignore: number }> => {
      return Effect.gen(function* () {
        // Nested .gitignore support: a directory's own .gitignore applies to its
        // subtree (appended AFTER ancestor patterns, so later = higher precedence
        // via last-match-wins, mirroring git). .banyancode/ignore stays root-only.
        const localIgnore = yield* loadDirGitignore(dir)
        const effectiveGitignore = localIgnore.length > 0 ? [...gitignorePatterns, ...localIgnore] : gitignorePatterns
        const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed<FSUtil.DirEntry[]>([])))
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
          if (isIgnoredByPatterns(effectiveGitignore, root, fullPath)) {
            skippedByGitignore++
            continue
          }
          if (isIgnoredByPatterns(banyanignorePatterns, root, fullPath)) {
            skippedByBanyanignore++
            continue
          }
          const subResult = yield* walkDirectory(fullPath, maxFileSizeBytes, root, effectiveGitignore, banyanignorePatterns)
          files.push(...subResult.files)
          skippedBySize += subResult.skippedBySize
          skippedByGitignore += subResult.skippedByGitignore
          skippedByBanyanignore += subResult.skippedByBanyanignore
        }
        for (const entry of entries) {
          if (entry.type !== "file") continue
          const fullPath = path.join(dir, entry.name)
          if (isIgnoredByPatterns(effectiveGitignore, root, fullPath)) {
            skippedByGitignore++
            continue
          }
          if (isIgnoredByPatterns(banyanignorePatterns, root, fullPath)) {
            skippedByBanyanignore++
            continue
          }
          const statOpt = yield* fs.stat(fullPath).pipe(Effect.option)
          if (statOpt._tag === "None") continue
          const stats = statOpt.value
          if (stats.size > maxFileSizeBytes) {
            yield* Effect.logDebug(`Skipping file exceeding size limit: ${path.relative(root, fullPath).replace(/\\/g, "/")} (${stats.size} bytes)`)
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

    const parseIgnoreLines = (content: string): string[] =>
      content.split("\n").filter((l) => l.trim() && !l.trimStart().startsWith("#"))

    // Memoized per-directory .gitignore contents, keyed by mtime so a
    // .gitignore created/edited between indexer calls is re-read (the
    // incremental path must observe new ignore files, e.g. applyChanges).
    const dirGitignoreCache = new Map<string, { mtimeMs: number; lines: string[] }>()
    const loadDirGitignore = (dir: string): Effect.Effect<string[]> => {
      return Effect.gen(function* () {
        const gitignorePath = path.join(dir, ".gitignore")
        const exists = yield* fs.existsSafe(gitignorePath)
        let mtimeMs = 0
        if (exists) {
          const statOpt = yield* fs.stat(gitignorePath).pipe(Effect.option)
          if (statOpt._tag === "Some") {
            const stats = statOpt.value
            mtimeMs = "value" in stats.mtime ? Math.floor(stats.mtime.value.getTime()) : 0
          }
        }
        const cached = dirGitignoreCache.get(dir)
        if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.lines
        const lines = exists ? parseIgnoreLines((yield* fs.readFileStringSafe(gitignorePath).pipe(Effect.orDie)) ?? "") : []
        dirGitignoreCache.set(dir, { mtimeMs, lines })
        return lines
      })
    }

    const loadIgnorePatterns = (root: string, excludePatterns?: readonly string[]): Effect.Effect<{ gitignore: string[]; banyanignore: string[] }> => {
      return Effect.gen(function* () {
        const gitignore: string[] = [...DEFAULT_IGNORED, ...DEFAULT_PRODUCT_EXCLUDES, ...DEFAULT_GENERATED_EXCLUDES]
        const banyanignore: string[] = []
        const banyancodeignorePath = path.join(root, ".banyancode", "ignore")
        gitignore.push(...(yield* loadDirGitignore(root)))
        const banyancodeExists = yield* fs.existsSafe(banyancodeignorePath)
        if (banyancodeExists) {
          const content = yield* fs.readFileStringSafe(banyancodeignorePath).pipe(Effect.orDie)
          if (content) banyanignore.push(...parseIgnoreLines(content))
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

    type CompiledIgnorePattern = { regex: RegExp; negated: boolean }
    const compiledPatternCache = new Map<string, CompiledIgnorePattern>()

    // gitignore-compatible pattern compiler: supports `**` (crosses slashes,
    // with leading `**/` matching zero or more directories), `*`/`?` (within a
    // segment), `!` negation (last matching pattern wins, git order semantics),
    // and trailing `/` (directory-only). A pattern matches a path if it matches
    // the path itself OR any directory prefix of it (git excludes a directory's
    // contents when the directory matches). Slashless patterns match basenames
    // at any depth; slashed patterns are relative to the ignore file's dir
    // (here: the workspace root).
    const compileIgnorePattern = (pattern: string): CompiledIgnorePattern | undefined => {
      let p = pattern.trim()
      if (p === "" || p.startsWith("#")) return undefined
      const negated = p.startsWith("!")
      if (negated) p = p.slice(1)
      p = p.replace(/\/+$/, "").replace(/^\/+/, "")
      if (p === "") return undefined
      const hasSlash = p.includes("/")
      // `**` markers are captured via placeholders BEFORE escaping, because
      // the inserted `(?:.*/)?` group would otherwise be mangled by the later
      // `*`/`?` segment replacements.
      let glob = p
        .replace(/\*\*\//g, "\u0001")
        .replace(/\*\*/g, "\u0002")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\u0001/g, "(?:.*/)?")
        .replace(/\u0002/g, ".*")
      if (!hasSlash) glob = `(?:.*/)?${glob}`
      return { regex: new RegExp(`^${glob}(?:/.*)?$`), negated }
    }

    const isIgnoredByPatterns = (patterns: string[], root: string, filePath: string): boolean => {
      const relativePath = path.relative(root, filePath).replace(/\\/g, "/")
      let ignored = false
      for (const pattern of patterns) {
        let compiled = compiledPatternCache.get(pattern)
        if (compiled === undefined) {
          compiled = compileIgnorePattern(pattern)
          if (compiled === undefined) continue
          compiledPatternCache.set(pattern, compiled)
        }
        if (compiled.regex.test(relativePath)) ignored = !compiled.negated
      }
      return ignored
    }

    // Pattern stack for a single file path: root patterns + every ancestor
    // directory's .gitignore (root-most first, so deeper files win). Used by
    // the incremental paths (applyChanges) so nested ignores apply there too.
    const patternsForPath = (root: string, filePath: string, base: string[]): Effect.Effect<string[]> =>
      Effect.gen(function* () {
        const segments = path.dirname(path.relative(root, filePath)).split(/[\\/]/).filter((s) => s !== "" && s !== ".")
        let stack = base
        let current = root
        for (const segment of segments) {
          current = path.join(current, segment)
          const local = yield* loadDirGitignore(current)
          if (local.length > 0) stack = [...stack, ...local]
        }
        return stack
      })

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
type StatOutcome = { kind: "ok"; stats: FileSystem.File.Info } | { kind: "vanished" } | { kind: "unreadable" }

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
        s.add(existing.id)
        return s
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
      yield* Effect.logDebug(`Skipping large file (potential bundle): ${relativePath} (${content.length} chars, limit: ${cfg.maxFileSizeBytes})`)
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
        s.add(existing.id)
        return s
      })
      yield* Queue.offer(cfg.parsedQueue, cfg.skippedParsed(relativePath))
      return
    }

    const lines = content.split("\n")
    const lineCount = lines.length

    if (lines.some((line) => line.length > 5000)) {
      yield* Effect.logDebug(`Skipping minified/compiled file: ${relativePath}`)
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
    if (isArtifact) {
      result = { nodes: [], edges: [] }
    } else if (TS_LIKE_EXTS.has(ext)) {
      result = parseTypeScript(content, fileID)
    } else if (PY_LIKE_EXTS.has(ext)) {
      result = parsePython(content, fileID)
    } else {
      result = parser.parse(content, fileID)
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
      endLine: lineCount,
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
  // Files grouped by normalized directory so the same-dir peer scan and the
  // configured_by scan avoid re-iterating every file in the graph per owner.
  const filesByDir = new Map<string, CodegraphFile[]>()
  for (const file of allFiles) {
    const dir = fileDir(file.path)
    const list = filesByDir.get(dir) ?? []
    list.push(file)
    filesByDir.set(dir, list)
  }

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
  // In incremental mode, iterate changed files plus dependent files as edge sources
  // (untouched files never need an import scope recomputed).
  const importScopesByFileID = new Map<string, Set<string>>()
  for (const [fileID, nodes] of nodesByFileID) {
    if (sourceSet && !sourceSet.has(fileID)) continue
    const fileNode = nodes.find((node) => node.kind === "file")
    const owner = fileByID.get(fileID)
    if (!fileNode?.code || !owner) continue
    const scope = new Set<string>()
    for (const match of fileNode.code.matchAll(/import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?["']([^"']+)["']/g)) {
      const specifier = match[1]
      if (!specifier) continue
      const importedFiles = deriveModuleCandidates(owner.path, specifier)
      for (const imported of importedFiles) {
        // Phase 5 (P8a): emit one `imports` edge per imported FILE — from
        // the importing file's file-kind node to the imported file's
        // file-kind node. Previously the declared `imports` edge kind was
        // only used to build the in-scope node set and no edge was ever
        // emitted, so `imports` never appeared in the graph. Dedup via the
        // shared referenceEdgeKeys set (distinct `${from}->${to}:imports`
        // key format) so a file imported by several statements yields one
        // edge. The endpoint guard (nodeByID.has) keeps the edge from ever
        // pointing at a node outside the current index window.
        const importedFileNodeID = `${imported.id}:file`
        if (nodeByID.has(importedFileNodeID)) {
          const importKey = `${fileNode.id}->${importedFileNodeID}:imports`
          if (!referenceEdgeKeys.has(importKey)) {
            referenceEdgeKeys.add(importKey)
            referenceEdges.push({
              fromNodeID: fileNode.id,
              toNodeID: importedFileNodeID,
              kind: "imports",
            })
          }
        }
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
        const peers = filesByDir.get(ownerDir) ?? []
        for (const file of peers) {
          if (file.id === owner.id) continue
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
    // Phase 5 (P8b): strip comment and string-literal regions BEFORE the
    // identifier scan and kind classification so a comment mentioning a
    // symbol or a string like `"callBash("` cannot fabricate a
    // `references`/`calls` edge. The original `nodeA.code` stays on the
    // node unchanged — the strip is only for edge classification.
    const strippedCode = stripCommentsAndStrings(nodeA.code)
    const identifiers = new Set<string>()
    for (const m of strippedCode.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
      if (m[0].length >= 3 && inScopeByName.has(m[0])) identifiers.add(m[0])
    }

    for (const name of identifiers) {
      const targets = inScopeByName.get(name)
      if (!targets || targets.length === 0) continue

      for (const nodeB of targets) {
        if (nodeB.id === nodeA.id) continue

        const kind =
          nodeA.kind === "class" && strippedCode.includes(`extends ${name}`)
            ? ("extends" as const)
            : strippedCode.includes(`${name}(`)
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
    for (const file of filesByDir.get(cfgDir) ?? []) {
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
      // Batch the prunes: chunk the orphan ids and delete each chunk inside
      // one transaction (repo.deleteFile nests its own transaction as a
      // savepoint, so per-file catch-cause logging is preserved while the
      // per-chunk commit overhead drops from 1 tx/file to 1 tx/900 files).
      const ORPHAN_DELETE_CHUNK = 900
      for (let i = 0; i < orphanFileRows.length; i += ORPHAN_DELETE_CHUNK) {
        const chunk = orphanFileRows.slice(i, i + ORPHAN_DELETE_CHUNK)
        yield* database.db.transaction(() =>
          Effect.gen(function* () {
            for (const orphan of chunk) {
              yield* repo.deleteFile(orphan.id).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(`Pruning orphaned file row failed for ${orphan.path}`, {
                    cause: Cause.pretty(cause),
                  }),
                ),
              )
            }
          }),
        ).pipe(Effect.orDie)
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
        const pathGitignore = yield* patternsForPath(input.root, filePath, gitignore)
        if (isIgnoredByPatterns(pathGitignore, input.root, filePath) || isIgnoredByPatterns(banyanignore, input.root, filePath)) {
          const existing = existingFilesByPath.get(filePath)
          if (existing) {
            removedFileIDs.add(existing.id)
            yield* repo.deleteFile(existing.id)
            existingFilesByPath.delete(filePath)
          }
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
      }

      for (const filePath of input.addedOrChanged) {
        const relativePath = path.relative(input.root, filePath).replace(/\\/g, "/")
        const pathGitignore = yield* patternsForPath(input.root, filePath, gitignore)
        if (isIgnoredByPatterns(pathGitignore, input.root, filePath) || isIgnoredByPatterns(banyanignore, input.root, filePath)) {
          const existing = existingFilesByPath.get(filePath)
          if (existing) {
            removedFileIDs.add(existing.id)
            yield* repo.deleteFile(existing.id)
            existingFilesByPath.delete(filePath)
          }
          skippedInputs++
          continue
        }
        const statOutcome = yield* fs.stat(filePath).pipe(
          Effect.map((stats) => ({ kind: "ok", stats }) as const),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed({ kind: "vanished" } as const)),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logDebug(`codegraph: stat failed, skipping ${relativePath}`, {
                cause: Cause.pretty(cause),
              })
              return { kind: "unreadable" } as const
            }),
          ),
        )
        if (statOutcome.kind === "vanished") {
          const existing = existingFilesByPath.get(filePath)
          if (existing) {
            removedFileIDs.add(existing.id)
            yield* repo.deleteFile(existing.id)
            existingFilesByPath.delete(filePath)
          }
          skippedInputs++
          continue
        }
        if (statOutcome.kind === "unreadable") {
          skippedInputs++
          continue
        }
        const stats = statOutcome.stats
        if (stats.type === "Directory") {
          // The watcher (Windows/Parcel) can deliver directory paths — sometimes
          // with a trailing separator — as a side effect of atomic-save rename
          // sequences or parent-directory updates. Stat-and-skip them here so
          // parseFile never reaches fs.readFileStringSafe with a directory
          // (which would raise PlatformError: BadResource, EISDIR).
          yield* Effect.logDebug(`Skipping directory path delivered by watcher: ${relativePath}`)
          skippedInputs++
          continue
        }
        if (stats.size > maxFileSizeBytes) {
          yield* Effect.logDebug(`Skipping large file (potential bundle): ${relativePath} (${stats.size} bytes, limit: ${maxFileSizeBytes})`)
          const existing = existingFilesByPath.get(filePath)
          if (existing) {
            removedFileIDs.add(existing.id)
            yield* repo.deleteFile(existing.id)
            existingFilesByPath.delete(filePath)
          }
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

// Note: CodegraphRepo.defaultLayer already provides Database.defaultLayer,
// so we don't provide it again here. Tests that need a custom DB path should
// build the layer as `CodegraphIndexer.layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(Database.layerFromPath(...)))`.
export const defaultLayer = layer.pipe(Layer.provide(CodegraphRepo.defaultLayer))
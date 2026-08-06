export * as CodegraphRepo from "./codegraph-repo"

import { and, eq, inArray, or, sql } from "drizzle-orm"
import { Cause, Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { CodegraphEdgesTable, CodegraphFilesTable, CodegraphNodesTable } from "./codegraph.sql"
import { CodegraphMetaTable } from "./codegraph-meta.sql"
import { CodegraphParseErrorsTable } from "./codegraph-parse-errors.sql"
import { CodegraphServiceTagsTable } from "./codegraph-service-tags.sql"
import { CodegraphTracesTable } from "./codegraph-traces.sql"
import { isTestFilePath } from "./codegraph-paths"
import type { CodegraphEdge, CodegraphFile, CodegraphMeta, CodegraphNode } from "./types"

export type FTSResult = CodegraphNode & { readonly bm25: number }

// Upper bound on nodes per DB insert batch. If a batched putNodes method is added,
// chunk the input into groups of this size to avoid overwhelming the SQLite connection.
export const MAX_NODES_PER_INSERT = 1000
const MAX_EDGES_PER_INSERT = 5000

// Single source of truth for the codegraph meta schema version. Written into
// `codegraph_meta.schema_version` by bumpVersion and compared by
// CodegraphReadiness to detect structural staleness. Keep in sync with the
// readiness consumer (codegraph-readiness.ts imports this constant — do NOT
// hardcode the literal in both files).
export const CODEGRAPH_SCHEMA_VERSION = 3

// Phase 3 query expansion: split an identifier-style query into its
// constituent lowercase tokens so a single user query like
// `CodegraphBuildService` (or `codegraph-build-service`, or `codegraph
// build service`) maps to FTS5 OR-terms that match either the full
// identifier or any of its sub-tokens. The trigram tokenizer on the FTS5
// table will already partial-match on 3-character substrings; this
// expansion is what makes `query: codegraph` find the row whose name is
// `CodegraphBuildService` even when the user types each word separately
// (e.g. `codegraph build service`).
//
// Splits applied (in order):
//   1. Whitespace — natural word boundary.
//   2. camelCase / PascalCase — `[A-Z][a-z]` and `[^A-Za-z0-9][A-Z]`
//      boundaries. The first regex covers `BuildService` → `Build Service`.
//      The second covers `XMLParser` → `XML Parser` and `codegraphBuild`
//      → `codegraph Build`.
//   3. Non-alphanumeric runs (`_`, `-`, `.`, etc.) — they all become
//      separators, matching how engineers mentally parse snake_case and
//      kebab-case.
//
// Output is lowercased, de-duped, and short tokens (< 3 chars) are
// dropped to align with trigram's 3-character minimum token length.
export const expandQueryToTokens = (query: string): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  // Step 1: whitespace split. Subsequent splits operate on each piece.
  const whitespacePieces = query.split(/\s+/).filter(Boolean)
  for (const piece of whitespacePieces) {
    // Step 2: camelCase boundary split. Insert a space between a lowercase
    // or digit and an uppercase, and between two uppercase letters when
    // followed by a lowercase (handles `XMLParser` → `XML Parser`).
    const camelSplit = piece
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    // Step 3: non-alphanumeric runs become separators. `_-./:` etc. all
    // drop out; alphanumerics remain.
    const tokens = camelSplit.split(/[^A-Za-z0-9]+/).filter(Boolean)
    for (const t of tokens) {
      const lower = t.toLowerCase()
      if (lower.length < 3) continue
      if (seen.has(lower)) continue
      seen.add(lower)
      out.push(lower)
    }
  }
  return out
}

const extractServiceTag = (code: string, nodeID: string, fileID: string): typeof CodegraphServiceTagsTable.$inferInsert | null => {
  // Match Context.Service<...>()("tag") or Context.Service<...>( ) ( "tag" ).
  // The non-greedy match for the generic argument list is bounded by a balanced
  // angle-bracket scan so nested generics (e.g. Context.Service<Service<Inner>, Interface>)
  // don't stop at the first inner `>`.
  const i = code.indexOf("Context.Service")
  if (i < 0) return null
  const lt = code.indexOf("<", i)
  if (lt < 0) return null
  let depth = 1
  let j = lt + 1
  for (; j < code.length && depth > 0; j++) {
    const ch = code[j]
    if (ch === "<") depth++
    else if (ch === ">") depth--
  }
  if (depth !== 0) return null
  // j now sits one past the closing `>` of Context.Service<...>.
  const tail = code.slice(j)
  const tagMatch = tail.match(/^\s*\(\s*\)\s*\(\s*["']([^"']+)["']\s*\)/)
  if (!tagMatch) return null
  const tag = tagMatch[1]
  const serviceName = tag.split("/").pop() ?? tag
  return {
    id: `${nodeID}:${tag}`,
    tag,
    service_name: serviceName,
    file_id: fileID,
    node_id: nodeID,
    class_name: "Service",
    indexed_at: Date.now(),
  }
}

const safeSize = (path: string): number => {
  try {
    return Bun.file(path).size ?? 0
  } catch {
    return 0
  }
}

// FK-safe deletion order for `clearAll`. Tables with no FK references are
// listed first; tables that hold foreign keys to other codegraph tables come
// last so the cascade has nothing left to reference. Single source of truth
// for `codegraph_*` tables — add new schema tables here and `clearAll` will
// pick them up automatically.
const codegraphSchemaTables = [
  CodegraphServiceTagsTable,
  CodegraphTracesTable,
  CodegraphParseErrorsTable,
  CodegraphMetaTable,
  CodegraphEdgesTable,
  CodegraphNodesTable,
  CodegraphFilesTable,
] as const

export interface Interface {
  readonly putFile: (file: CodegraphFile) => Effect.Effect<void, never, never>
  readonly getFile: (id: string) => Effect.Effect<CodegraphFile | undefined, never, never>
  readonly getFileByPath: (path: string) => Effect.Effect<CodegraphFile | undefined, never, never>
  readonly listAllFiles: () => Effect.Effect<CodegraphFile[], never, never>
  readonly putNode: (node: CodegraphNode) => Effect.Effect<void, never, never>
  readonly putNodes: (nodes: CodegraphNode[]) => Effect.Effect<void, never, never>
  readonly getNode: (id: string) => Effect.Effect<CodegraphNode | undefined, never, never>
  readonly nodeByID: (id: string) => Effect.Effect<CodegraphNode | undefined, never, never>
  readonly nodesByIDs: (ids: string[]) => Effect.Effect<CodegraphNode[], never, never>
  readonly listNodesByFile: (fileID: string) => Effect.Effect<CodegraphNode[], never, never>
  readonly listNodesByKind: (kind: string) => Effect.Effect<CodegraphNode[], never, never>
  readonly listAllNodes: () => Effect.Effect<CodegraphNode[], never, never>
  readonly queryNodes: (input: { function?: string; kind?: string }) => Effect.Effect<CodegraphNode[], never, never>
  readonly searchNodes: (input: { name?: string; kind?: string; limit?: number }) => Effect.Effect<CodegraphNode[], never, never>
  /** Like searchNodes but without the `code` field — suitable for callers that only need metadata. */
  readonly searchNodesLight: (input: { name?: string; kind?: string; fileID?: string; limit?: number }) => Effect.Effect<Array<Omit<CodegraphNode, "code"> & { code?: never }>, never, never>
  /** FTS5 full-text search across symbol names and code, ranked by bm25. */
  readonly ftsSearchNodes: (input: { query: string; limit?: number }) => Effect.Effect<FTSResult[], never, never>
  /** Fetch nodes for a specific set of files. Used by incremental rebuildDerivedGraph. */
  readonly nodesByFileIDs: (input: { fileIDs: string[] }) => Effect.Effect<CodegraphNode[], never, never>
  readonly dependentsOfFiles: (input: {
    fileIDs: readonly string[]
    limit?: number
  }) => Effect.Effect<readonly string[], never, never>
  readonly filesByIDs: (ids: ReadonlyArray<string>) => Effect.Effect<CodegraphFile[], never, never>
  readonly countNodes: () => Effect.Effect<number, never, never>
  readonly countEdges: () => Effect.Effect<number, never, never>
  readonly countFiles: () => Effect.Effect<number, never, never>
  /**
   * Phase 1 (freshness): count file rows whose `mtime_ms` is newer than
   * their `indexed_at` — i.e. files whose content changed on disk after
   * (or during) the snapshot the graph was built from. This is the
   * per-file drift signal meta-age/coverage staleness cannot see.
   */
  readonly countStaleFiles: () => Effect.Effect<number, never, never>
  /**
   * Phase 6 (usage surface): read the `codegraph_tool_usage` rows most-used
   * first. Consumers (HTTP `GET /global/tool-usage`, the TUI sidebar widget)
   * surface tool adoption; the hot-tier promotion gate in `AdaptedCatalog`
   * already reads the same table for the last-24h window.
   *
   * Phase C (per-session adoption): pass `{ session }` to scope the read to
   * rows whose `session_id` matches (the session that most recently used the
   * tool). Omitting the filter keeps the lifetime-aggregate contract.
   */
  readonly listToolUsage: (input?: { session?: string }) => Effect.Effect<
    ReadonlyArray<{ toolId: string; useCount: number; lastUsedAt: number }>,
    never,
    never
  >
  readonly putEdge: (edge: CodegraphEdge) => Effect.Effect<void, never, never>
  readonly putEdges: (edges: CodegraphEdge[]) => Effect.Effect<void, never, never>
  readonly getEdge: (id: string) => Effect.Effect<CodegraphEdge | undefined, never, never>
  readonly listAllEdges: () => Effect.Effect<CodegraphEdge[], never, never>
  readonly listEdgesByNode: (nodeID: string) => Effect.Effect<CodegraphEdge[], never, never>
  readonly edgesFrom: (nodeID: string) => Effect.Effect<CodegraphEdge[], never, never>
  readonly edgesTo: (nodeID: string) => Effect.Effect<CodegraphEdge[], never, never>
  readonly edgesFromBatch: (ids: ReadonlyArray<string>) => Effect.Effect<CodegraphEdge[], never, never>
  readonly edgesToBatch: (ids: ReadonlyArray<string>) => Effect.Effect<CodegraphEdge[], never, never>
  readonly deleteFile: (id: string) => Effect.Effect<void, never, never>
  readonly deleteDerivedEdgesForFiles: (input: { fileIDs: string[] }) => Effect.Effect<readonly string[], never, never>
  /**
   * Phase 3d-followup: full-rebuild derived-edge purge. Wipes every edge whose
   * `kind` is in the derived set (`calls`, `extends`, `references`, `tested_by`,
   * `configured_by`, `built_by`, `mounts`, `generated_from`) regardless of
   * which file it came from, leaving parser edges (`imports`, `contains`)
   * intact. Required because pre-Phase-3a full rebuilds inserted edges
   * with `onConflictDoNothing` without ever purging; the warm-graph
   * edge-count drift (18,971 vs 185,012) was ~90% stale accumulation.
   *
   * Full-mode callers must follow up with `recomputeInDegree` over EVERY
   * node in the graph — not just the touched subset — because in-degree
   * counts for nodes with no remaining derived edges become zero.
   */
  readonly deleteAllDerivedEdges: () => Effect.Effect<readonly string[], never, never>
  /**
   * Atomically replace one file's worth of graph data: if `previousFileID`
   * is set, delete that file (cascade-removes its nodes/edges); then insert
   * the new file row, all its nodes, and all its per-file edges in a single
   * transaction. Replaces the ~15 individual auto-committed writes the
   * indexer used to do per file, which is what caused the 1+ GB WAL during
   * real-workspace builds.
   */
  readonly writeFileGraph: (input: {
    file: CodegraphFile
    nodes: CodegraphNode[]
    edges: CodegraphEdge[]
    previousFileID?: string
  }) => Effect.Effect<void, never, never>
  readonly clearAll: (
    input?: { dropFile?: boolean },
  ) => Effect.Effect<{ sizeBefore: number; sizeAfter: number; droppedFile: boolean }, never, never>
  // Phase 3: recompute `codegraph_nodes.in_degree` from
  // `codegraph_edges.to_node_id`. Called by the indexer after the parse
  // pass writes all edges, so the ranker can read the column instead of
  // running COUNT(*) per candidate.
  readonly recomputeInDegree: (input?: { nodeIDs?: readonly string[] }) => Effect.Effect<void, never, never>
  /**
   * Phase 2: refresh `indexed_at` on a batch of files in one update.
   * Called by the indexer after the drain loop completes so cache-hit
   * files get an updated `indexed_at` (without this, downstream time
   * heuristics that compare mtime to indexed_at would fire forever on
   * those files even though their content was unchanged).
   */
  readonly bumpIndexedAt: (input: { fileIDs: readonly string[]; indexedAt: number }) => Effect.Effect<void, never, never>
  readonly getMeta: () => Effect.Effect<CodegraphMeta | undefined, never, never>
  readonly setMeta: (m: CodegraphMeta) => Effect.Effect<void, never, never>
  readonly bumpVersion: (input: {
    /**
     * Files the walker considered eligible for indexing (total walked minus
     * gitignored / banyanignored). The denominator for graphCoverage. If
     * omitted, falls back to `scannedFiles` for backward-compat with
     * callers that haven't been updated yet.
     */
    eligibleFiles?: number
    /**
     * Backward-compat: legacy denominator. Used only when `eligibleFiles`
     * is undefined.
     */
    scannedFiles?: number
    /** Ignored. Kept for backward-compat with build-service callers. */
    indexedFiles?: number
    /** Ignored. Kept for backward-compat with build-service callers. */
    totalFiles?: number
    /** Ignored. Kept for backward-compat with build-service callers. */
    totalNodes?: number
    /** Ignored. Kept for backward-compat with build-service callers. */
    totalEdges?: number
    indexedRoot?: string
  }) => Effect.Effect<
    {
      graphVersion: number
      coverage: number
      totalNodes: number
      totalEdges: number
      totalFiles: number
      graphBuiltAt: number
    },
    never,
    never
  >
  readonly recordParseError: (input: { path: string; cause: string; indexedAt: number }) => Effect.Effect<void, unknown, never>
  readonly listParseErrors: () => Effect.Effect<Array<{ path: string; cause: string; indexedAt: number }>, never, never>
  readonly clearParseErrors: () => Effect.Effect<void, never, never>
  readonly findSymbolsByServiceTag: (tag: string) => Effect.Effect<CodegraphNode[], never, never>
  readonly lookupByServiceTag: (tag: string) => Effect.Effect<CodegraphNode | null, never, never>
  /**
   * Resolver support: distinct file_ids whose `codegraph_service_tags.service_name`
   * matches the given symbol name. Lets qualified-split (`Namespace.leaf`) find
   * the file even when the class is `extends Context.Service<...>` and indexed
   * under `name: "Service"` — the tag's `service_name` carries the namespace.
   * Returns an empty array if no match.
   */
  readonly fileIDsByServiceName: (serviceName: string) => Effect.Effect<readonly string[], never, never>
  readonly rebuildFtsIndex: () => Effect.Effect<{ rowsIndexed: number }, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Banyan/CodegraphRepo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const putFile = Effect.fn("CodegraphRepo.putFile")(function* (file: CodegraphFile) {
      yield* db
        .insert(CodegraphFilesTable)
        .values({
          id: file.id,
          path: file.path,
          content_hash: file.contentHash,
          language: file.language,
          indexed_at: file.indexedAt,
          size_bytes: file.sizeBytes ?? 0,
          mtime_ms: file.mtimeMs ?? 0,
        })
        .onConflictDoUpdate({
          target: CodegraphFilesTable.path,
          set: {
            content_hash: file.contentHash,
            language: file.language,
            indexed_at: file.indexedAt,
            size_bytes: file.sizeBytes ?? 0,
            mtime_ms: file.mtimeMs ?? 0,
          },
        })
        .run()
        .pipe(Effect.orDie)
    })

    const getFile = Effect.fn("CodegraphRepo.getFile")(function* (id: string) {
      const row = yield* db
        .select()
        .from(CodegraphFilesTable)
        .where(eq(CodegraphFilesTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return {
        id: row.id,
        path: row.path,
        contentHash: row.content_hash,
        language: row.language,
        indexedAt: row.indexed_at,
        sizeBytes: row.size_bytes,
        mtimeMs: row.mtime_ms,
      }
    })

    const getFileByPath = Effect.fn("CodegraphRepo.getFileByPath")(function* (path: string) {
      const row = yield* db
        .select()
        .from(CodegraphFilesTable)
        .where(eq(CodegraphFilesTable.path, path))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return {
        id: row.id,
        path: row.path,
        contentHash: row.content_hash,
        language: row.language,
        indexedAt: row.indexed_at,
        sizeBytes: row.size_bytes,
        mtimeMs: row.mtime_ms,
      }
    })

    const listAllFiles = Effect.fn("CodegraphRepo.listAllFiles")(function* () {
      const rows = yield* db.select().from(CodegraphFilesTable).all().pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        path: row.path,
        contentHash: row.content_hash,
        language: row.language,
        indexedAt: row.indexed_at,
        sizeBytes: row.size_bytes,
        mtimeMs: row.mtime_ms,
      }))
    })

    const putNode = Effect.fn("CodegraphRepo.putNode")(function* (node: CodegraphNode) {
      const rawIsEp = (node as CodegraphNode & { isEntrypoint?: number | boolean | undefined }).isEntrypoint
      const isEntrypoint = rawIsEp ? 1 : 0
      const rawInDeg = (node as CodegraphNode & { inDegree?: number | undefined }).inDegree
      const inDegree = typeof rawInDeg === "number" ? rawInDeg : 0
      yield* db
        .insert(CodegraphNodesTable)
        .values({
          id: node.id,
          file_id: node.fileID,
          kind: node.kind,
          name: node.name,
          signature: node.signature,
          start_line: node.startLine,
          end_line: node.endLine,
          code: node.code,
          is_entrypoint: isEntrypoint,
          in_degree: inDegree,
        })
        .onConflictDoUpdate({
          target: CodegraphNodesTable.id,
          set: {
            file_id: node.fileID,
            kind: node.kind,
            name: node.name,
            signature: node.signature,
            start_line: node.startLine,
            end_line: node.endLine,
            code: node.code,
            is_entrypoint: isEntrypoint,
          },
        })
        .run()
        .pipe(Effect.orDie)
    })

    const getNode = Effect.fn("CodegraphRepo.getNode")(function* (id: string) {
      const row = yield* db
        .select()
        .from(CodegraphNodesTable)
        .where(eq(CodegraphNodesTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return {
        id: row.id,
        fileID: row.file_id,
        kind: row.kind as CodegraphNode["kind"],
        name: row.name,
        signature: row.signature ?? undefined,
        startLine: row.start_line,
        endLine: row.end_line,
        code: row.code ?? undefined,
        isEntrypoint: row.is_entrypoint,
        inDegree: row.in_degree,
      } as CodegraphNode & { isEntrypoint?: number; inDegree?: number }
    })

    const rowToNode = (row: typeof CodegraphNodesTable.$inferSelect): CodegraphNode =>
      ({
        id: row.id,
        fileID: row.file_id,
        kind: row.kind as CodegraphNode["kind"],
        name: row.name,
        signature: row.signature ?? undefined,
        startLine: row.start_line,
        endLine: row.end_line,
        code: row.code ?? undefined,
        isEntrypoint: row.is_entrypoint,
        inDegree: row.in_degree,
      } as CodegraphNode & { isEntrypoint?: number; inDegree?: number })

    const listNodesByFile = Effect.fn("CodegraphRepo.listNodesByFile")(function* (fileID: string) {
      const rows = yield* db
        .select()
        .from(CodegraphNodesTable)
        .where(eq(CodegraphNodesTable.file_id, fileID))
        .all()
        .pipe(Effect.orDie)
      return rows.map(rowToNode)
    })

    const listNodesByKind = Effect.fn("CodegraphRepo.listNodesByKind")(function* (kind: string) {
      const rows = yield* db
        .select()
        .from(CodegraphNodesTable)
        .where(eq(CodegraphNodesTable.kind, kind))
        .all()
        .pipe(Effect.orDie)
      return rows.map(rowToNode)
    })

    const listAllNodes = Effect.fn("CodegraphRepo.listAllNodes")(function* () {
      const rows = yield* db.select().from(CodegraphNodesTable).all().pipe(Effect.orDie)
      return rows.map(rowToNode)
    })

    const putEdge = Effect.fn("CodegraphRepo.putEdge")(function* (edge: CodegraphEdge) {
      yield* db
        .insert(CodegraphEdgesTable)
        .values({
          id: edge.id,
          from_node_id: edge.fromNodeID,
          to_node_id: edge.toNodeID,
          kind: edge.kind,
        })
        .onConflictDoUpdate({
          target: CodegraphEdgesTable.id,
          set: {
            from_node_id: edge.fromNodeID,
            to_node_id: edge.toNodeID,
            kind: edge.kind,
          },
        })
        .run()
        .pipe(Effect.orDie)
    })

    const getEdge = Effect.fn("CodegraphRepo.getEdge")(function* (id: string) {
      const row = yield* db
        .select()
        .from(CodegraphEdgesTable)
        .where(eq(CodegraphEdgesTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return {
        id: row.id,
        fromNodeID: row.from_node_id,
        toNodeID: row.to_node_id,
        kind: row.kind as CodegraphEdge["kind"],
      }
    })

    const listAllEdges = Effect.fn("CodegraphRepo.listAllEdges")(function* () {
      const rows = yield* db
        .select()
        .from(CodegraphEdgesTable)
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        fromNodeID: row.from_node_id,
        toNodeID: row.to_node_id,
        kind: row.kind as CodegraphEdge["kind"],
      }))
    })

    const listEdgesByNode = Effect.fn("CodegraphRepo.listEdgesByNode")(function* (nodeID: string) {
      const rows = yield* db
        .select()
        .from(CodegraphEdgesTable)
        .where(eq(CodegraphEdgesTable.from_node_id, nodeID))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        fromNodeID: row.from_node_id,
        toNodeID: row.to_node_id,
        kind: row.kind as CodegraphEdge["kind"],
      }))
    })

    const deleteFile = Effect.fn("CodegraphRepo.deleteFile")(function* (id: string) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            // Service tags point at codegraph_nodes, not directly at the file;
            // without this delete they survive a rebuild and block re-registration.
            yield* tx
              .delete(CodegraphServiceTagsTable)
              .where(eq(CodegraphServiceTagsTable.file_id, id))
              .run()
              .pipe(Effect.orDie)
            yield* tx.delete(CodegraphFilesTable).where(eq(CodegraphFilesTable.id, id)).run().pipe(Effect.orDie)
          }),
        )
        .pipe(Effect.orDie)
    })

    // Clears edges that became invalid because their endpoints' files were re-indexed.
    const deleteDerivedEdgesForFiles = Effect.fn("CodegraphRepo.deleteDerivedEdgesForFiles")(function* (input: { fileIDs: string[] }) {
      if (input.fileIDs.length === 0) return []
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const nodeIDRows = yield* tx
            .select({ id: CodegraphNodesTable.id })
            .from(CodegraphNodesTable)
            .where(inArray(CodegraphNodesTable.file_id, input.fileIDs))
            .all()
            .pipe(Effect.orDie)
          const nodeIDs = nodeIDRows.map((r) => r.id)
          if (nodeIDs.length === 0) return []
          const derivedWhere = and(
            or(
              inArray(CodegraphEdgesTable.from_node_id, nodeIDs),
              inArray(CodegraphEdgesTable.to_node_id, nodeIDs),
            ),
            or(
              eq(CodegraphEdgesTable.kind, "calls"),
              eq(CodegraphEdgesTable.kind, "extends"),
              eq(CodegraphEdgesTable.kind, "references"),
              eq(CodegraphEdgesTable.kind, "tested_by"),
              eq(CodegraphEdgesTable.kind, "configured_by"),
              eq(CodegraphEdgesTable.kind, "built_by"),
              eq(CodegraphEdgesTable.kind, "mounts"),
              eq(CodegraphEdgesTable.kind, "generated_from"),
            ),
          )
          const deletedRows = yield* tx
            .select({ from: CodegraphEdgesTable.from_node_id, to: CodegraphEdgesTable.to_node_id })
            .from(CodegraphEdgesTable)
            .where(derivedWhere)
            .all()
            .pipe(Effect.orDie)
          yield* tx
            .delete(CodegraphEdgesTable)
            .where(derivedWhere)
            .run()
            .pipe(Effect.orDie)
          const touched = new Set<string>(nodeIDs)
          for (const row of deletedRows) {
            touched.add(row.from)
            touched.add(row.to)
          }
          return [...touched]
        }),
      ).pipe(Effect.orDie)
    })

    const deleteAllDerivedEdges = Effect.fn("CodegraphRepo.deleteAllDerivedEdges")(function* () {
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const derivedKinds = [
            "calls",
            "extends",
            "references",
            "tested_by",
            "configured_by",
            "built_by",
            "mounts",
            "generated_from",
          ]
          const deletedRows = yield* tx
            .select({ from: CodegraphEdgesTable.from_node_id, to: CodegraphEdgesTable.to_node_id })
            .from(CodegraphEdgesTable)
            .where(inArray(CodegraphEdgesTable.kind, derivedKinds))
            .all()
            .pipe(Effect.orDie)
          yield* tx
            .delete(CodegraphEdgesTable)
            .where(inArray(CodegraphEdgesTable.kind, derivedKinds))
            .run()
            .pipe(Effect.orDie)
          const touched = new Set<string>()
          for (const row of deletedRows) {
            touched.add(row.from)
            touched.add(row.to)
          }
          return [...touched]
        }),
      ).pipe(Effect.orDie)
    })

    const nodeByID = Effect.fn("CodegraphRepo.nodeByID")(function* (id: string) {
      return yield* getNode(id)
    })

    const nodesByIDs = Effect.fn("CodegraphRepo.nodesByIDs")(function* (ids: string[]) {
      if (ids.length === 0) return []
      const chunkSize = 900
      const allRows = []
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize)
        const rows = yield* db
          .select()
          .from(CodegraphNodesTable)
          .where(inArray(CodegraphNodesTable.id, chunk))
          .all()
          .pipe(Effect.orDie)
        allRows.push(...rows)
      }
      return allRows.map(rowToNode)
    })

    const queryNodes = Effect.fn("CodegraphRepo.queryNodes")(function* (input: { function?: string; kind?: string }) {
      const conditions = []
      if (input.function) {
        conditions.push(eq(CodegraphNodesTable.name, input.function))
      }
      if (input.kind) {
        conditions.push(eq(CodegraphNodesTable.kind, input.kind))
      }
      if (conditions.length === 0) return []
      const rows = yield* db
        .select()
        .from(CodegraphNodesTable)
        .where(and(...conditions))
        .all()
        .pipe(Effect.orDie)
      return rows.map(rowToNode)
    })

    const searchNodes = Effect.fn("CodegraphRepo.searchNodes")(function* (input: {
      name?: string
      kind?: string
      limit?: number
    }) {
      const limit = input.limit ?? 1000
      const conditions = []
      if (input.name) {
        conditions.push(sql`${CodegraphNodesTable.name} LIKE ${"%" + input.name + "%"}`)
      }
      if (input.kind) {
        conditions.push(sql`${CodegraphNodesTable.kind} = ${input.kind}`)
      }
      const whereClause = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``
      const rows = yield* db
        .all<typeof CodegraphNodesTable.$inferSelect>(sql`
          SELECT * FROM codegraph_nodes
          ${whereClause}
          ORDER BY codegraph_nodes.name
          LIMIT ${limit}
        `)
        .pipe(Effect.orDie)
      return rows.map(rowToNode)
    })

    const searchNodesLight = Effect.fn("CodegraphRepo.searchNodesLight")(function* (input: {
      name?: string
      kind?: string
      fileID?: string
      limit?: number
    }) {
      const limit = input.limit ?? 1000
      const conditions = []
      if (input.name) {
        conditions.push(sql`${CodegraphNodesTable.name} LIKE ${"%" + input.name + "%"}`)
      }
      if (input.kind) {
        conditions.push(sql`${CodegraphNodesTable.kind} = ${input.kind}`)
      }
      if (input.fileID) {
        conditions.push(sql`${CodegraphNodesTable.file_id} = ${input.fileID}`)
      }
      const whereClause = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``
      const rows = yield* db
        .all<{
          id: string
          file_id: string
          kind: string
          name: string
          signature: string | null
          start_line: number
          end_line: number
        }>(sql`
          SELECT id, file_id, kind, name, signature, start_line, end_line
          FROM codegraph_nodes
          ${whereClause}
          ORDER BY codegraph_nodes.name
          LIMIT ${limit}
        `)
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        fileID: row.file_id,
        kind: row.kind as CodegraphNode["kind"],
        name: row.name,
        signature: row.signature ?? undefined,
        startLine: row.start_line,
        endLine: row.end_line,
      }))
    })

    const ftsSearchNodes = Effect.fn("CodegraphRepo.ftsSearchNodes")(function* (input: {
      query: string
      limit?: number
    }) {
      const limit = input.limit ?? 50
      // FTS5 reserved chars that would either terminate the MATCH expression
      // (`"`, `'`) or are operators in the FTS5 mini-language (`(`, `)`, `*`,
      // `:`, `^`, `-`, `+`, `NEAR`, `AND`, `OR`, `NOT`). Strip them defensively
      // so a query like `function 'drop table' --` cannot corrupt the FTS5
      // parser and cannot be used as a probe for unindexed columns.
      const sanitized = input.query.replace(/["'()*:\-]/g, " ").trim()
      if (!sanitized) return []
      const tokens = expandQueryToTokens(sanitized)
      if (tokens.length === 0) return []
      // Multi-token queries join terms with AND (all terms must match) so
      // "session recovery" no longer surfaces every node containing "session"
      // OR "recovery". When the AND query returns zero hits we re-run with OR
      // as a recall fallback — a single well-known identifier buried in the
      // code column is better returned than missed entirely. Single-token
      // queries always use OR (trivially the same as the bare term).
      const quote = (t: string) => `"${t}"`
      const andQuery = tokens.map(quote).join(" AND ")
      const orQuery = tokens.map(quote).join(" OR ")
      type FTSRow = {
        id: string
        file_id: string
        kind: string
        name: string
        signature: string | null
        start_line: number
        end_line: number
        code: string | null
        bm25: number
      }
      // Phase 3: column-weighted bm25 ranking. In FTS5's `bm25(table, w1, w2, ...)`
      // each `wi` is the weight of the i-th column in the BM25 sum; higher
      // weights produce a more-negative bm25 (= better rank) when a term
      // matches that column. The chosen triple (name=10.0, signature=3.0,
      // code=1.0) gives a name-only hit the strongest boost, a signature-
      // only hit a moderate boost, and a code-only hit the smallest boost.
      //
      // Why the Plan-3 weights are reversed from a naive "lower weight =
      // better" reading: FTS5's bm25() returns the NEGATIVE of the weighted
      // TF-IDF sum, so multiplying a column by 10 makes its matches more
      // negative (better) by 10x, not worse. Verified empirically against
      // the bundled libsql FTS5 build (see test/banyancode/fts-bm25-weights.test.ts).
      //
      // Rationale:
      //   - `name` is the most authoritative signal — when an identifier
      //     string appears in `codegraph_nodes.name`, the user almost
      //     certainly means that symbol. weight=10.0 (strongest boost).
      //   - `signature` is the second most authoritative — method
      //     declarations live in the signature column when the indexer
      //     strips the body. weight=3.0 keeps signature-only hits well ahead
      //     of code-only hits but well behind a real name match.
      //   - `code` is the noisiest — a word like "function" or "return" is
      //     in every code body. weight=1.0 makes code-only hits the weakest
      //     signal so they don't drown the symbol hits.
      //
      // ORDER BY bm25 ASC because FTS5's bm25() returns more-negative values
      // for better matches (negated sum of term-frequency / inverse-document-
      // frequency contributions, per the SQLite docs).
      const runFts = (match: string): Effect.Effect<FTSRow[], never, never> =>
        db
          .all<FTSRow>(sql`
            SELECT n.id, n.file_id, n.kind, n.name, n.signature, n.start_line, n.end_line, n.code,
                   bm25(codegraph_fts, 10.0, 3.0, 1.0) AS bm25
            FROM codegraph_fts
            INNER JOIN codegraph_nodes n ON n.rowid = codegraph_fts.rowid
            WHERE codegraph_fts MATCH ${match}
            ORDER BY bm25
            LIMIT ${limit}
          `)
          .pipe(Effect.orDie)

      let rows: FTSRow[]
      if (tokens.length >= 2) {
        const andRows = yield* runFts(andQuery)
        rows = andRows.length > 0 ? andRows : yield* runFts(orQuery)
      } else {
        rows = yield* runFts(orQuery)
      }
      return rows.map((row) => ({
        id: row.id,
        fileID: row.file_id,
        kind: row.kind as CodegraphNode["kind"],
        name: row.name,
        signature: row.signature ?? undefined,
        startLine: row.start_line,
        endLine: row.end_line,
        code: row.code ?? undefined,
        bm25: row.bm25,
      }))
    })

    const nodesByFileIDs = Effect.fn("CodegraphRepo.nodesByFileIDs")(function* (input: { fileIDs: string[] }) {
      if (input.fileIDs.length === 0) return []
      const rows = yield* db
        .select()
        .from(CodegraphNodesTable)
        .where(inArray(CodegraphNodesTable.file_id, input.fileIDs))
        .all()
        .pipe(Effect.orDie)
      return rows.map(rowToNode)
    })

    const filesByIDs = Effect.fn("CodegraphRepo.filesByIDs")(function* (ids: ReadonlyArray<string>) {
      if (ids.length === 0) return []
      const chunkSize = 900
      const allRows: typeof CodegraphFilesTable.$inferSelect[] = []
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize)
        const rows = yield* db
          .select()
          .from(CodegraphFilesTable)
          .where(inArray(CodegraphFilesTable.id, chunk))
          .all()
          .pipe(Effect.orDie)
        allRows.push(...rows)
      }
      return allRows.map((row) => ({
        id: row.id,
        path: row.path,
        contentHash: row.content_hash,
        language: row.language,
        indexedAt: row.indexed_at,
        sizeBytes: row.size_bytes,
        mtimeMs: row.mtime_ms,
      }))
    })

    const countNodes = Effect.fn("CodegraphRepo.countNodes")(function* () {
      const row = yield* db
        .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM codegraph_nodes`)
        .pipe(Effect.orDie)
      return row?.c ?? 0
    })

    const countEdges = Effect.fn("CodegraphRepo.countEdges")(function* () {
      const row = yield* db
        .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM codegraph_edges`)
        .pipe(Effect.orDie)
      return row?.c ?? 0
    })

    const countFiles = Effect.fn("CodegraphRepo.countFiles")(function* () {
      const row = yield* db
        .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM codegraph_files`)
        .pipe(Effect.orDie)
      return row?.c ?? 0
    })

    const countStaleFiles = Effect.fn("CodegraphRepo.countStaleFiles")(function* () {
      const row = yield* db
        .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM codegraph_files WHERE mtime_ms > indexed_at`)
        .pipe(Effect.orDie)
      return row?.c ?? 0
    })

    const listToolUsage = Effect.fn("CodegraphRepo.listToolUsage")(function* (input?: { session?: string }) {
      const rows = yield* db
        .all<{ tool_id: string; use_count: number; last_used_at: number }>(sql`
          SELECT tool_id, use_count, last_used_at FROM codegraph_tool_usage
          ${input?.session !== undefined ? sql`WHERE session_id = ${input.session}` : sql``}
          ORDER BY use_count DESC LIMIT 50
        `)
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        toolId: row.tool_id,
        useCount: row.use_count,
        lastUsedAt: row.last_used_at,
      }))
    })

    const edgesFrom = Effect.fn("CodegraphRepo.edgesFrom")(function* (nodeID: string) {
      return yield* listEdgesByNode(nodeID)
    })

    const edgesTo = Effect.fn("CodegraphRepo.edgesTo")(function* (nodeID: string) {
      const rows = yield* db
        .select()
        .from(CodegraphEdgesTable)
        .where(eq(CodegraphEdgesTable.to_node_id, nodeID))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        fromNodeID: row.from_node_id,
        toNodeID: row.to_node_id,
        kind: row.kind as CodegraphEdge["kind"],
      }))
    })

    const edgesFromBatch = Effect.fn("CodegraphRepo.edgesFromBatch")(function* (ids: ReadonlyArray<string>) {
      if (ids.length === 0) return []
      const chunkSize = 900
      const allRows: typeof CodegraphEdgesTable.$inferSelect[] = []
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize)
        const rows = yield* db
          .select()
          .from(CodegraphEdgesTable)
          .where(inArray(CodegraphEdgesTable.from_node_id, chunk))
          .all()
          .pipe(Effect.orDie)
        allRows.push(...rows)
      }
      return allRows.map((row) => ({
        id: row.id,
        fromNodeID: row.from_node_id,
        toNodeID: row.to_node_id,
        kind: row.kind as CodegraphEdge["kind"],
      }))
    })

    const edgesToBatch = Effect.fn("CodegraphRepo.edgesToBatch")(function* (ids: ReadonlyArray<string>) {
      if (ids.length === 0) return []
      const chunkSize = 900
      const allRows: typeof CodegraphEdgesTable.$inferSelect[] = []
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize)
        const rows = yield* db
          .select()
          .from(CodegraphEdgesTable)
          .where(inArray(CodegraphEdgesTable.to_node_id, chunk))
          .all()
          .pipe(Effect.orDie)
        allRows.push(...rows)
      }
      return allRows.map((row) => ({
        id: row.id,
        fromNodeID: row.from_node_id,
        toNodeID: row.to_node_id,
        kind: row.kind as CodegraphEdge["kind"],
      }))
    })

    const dependentsOfFiles = Effect.fn("CodegraphRepo.dependentsOfFiles")(function* (input: {
      fileIDs: readonly string[]
      limit?: number
    }) {
      const fileIDs = [...new Set(input.fileIDs)]
      const limit = input.limit === undefined ? undefined : Math.max(0, Math.floor(input.limit))
      if (fileIDs.length === 0 || limit === 0) return []

      const changedNodes: CodegraphNode[] = []
      for (let i = 0; i < fileIDs.length; i += 900) {
        const nodes = yield* nodesByFileIDs({ fileIDs: fileIDs.slice(i, i + 900) })
        changedNodes.push(...nodes)
      }
      if (changedNodes.length === 0) return []

      const changedNodeIDs = changedNodes.map((node) => node.id)
      const [edgesFromChanged, edgesToChanged] = yield* Effect.all([
        edgesFromBatch(changedNodeIDs),
        edgesToBatch(changedNodeIDs),
      ])
      const otherNodeIDs = new Set<string>()
      for (const edge of edgesFromChanged) otherNodeIDs.add(edge.toNodeID)
      for (const edge of edgesToChanged) otherNodeIDs.add(edge.fromNodeID)
      if (otherNodeIDs.size === 0) return []

      const changedFileIDs = new Set(fileIDs)
      const otherNodes = yield* nodesByIDs([...otherNodeIDs])
      const dependentFileIDs = new Set<string>()
      for (const node of otherNodes) {
        if (changedFileIDs.has(node.fileID)) continue
        dependentFileIDs.add(node.fileID)
      }

      const result = [...dependentFileIDs].sort()
      return limit === undefined ? result : result.slice(0, limit)
    })

    const clearAll = Effect.fn("CodegraphRepo.clearAll")(function* (input?: { dropFile?: boolean }) {
      const filePath = Database.path()
      const sizeBefore = filePath !== ":memory:" ? safeSize(filePath) : 0

      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            for (const table of codegraphSchemaTables) {
              yield* tx.delete(table).run().pipe(Effect.orDie)
            }
          }),
        )
        .pipe(Effect.orDie)

      // Checkpoint the WAL so the on-disk DB file actually shrinks after we
      // delete rows. Without this, rows are gone but the file may keep its
      // pre-delete size until the next VACUUM or full checkpoint.
      yield* db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`).pipe(Effect.orDie)

      // VACUUM rewrites the main DB file from scratch, releasing every page
      // freed by the row deletes. Without it, the file size barely changes
      // even though the rows are gone. VACUUM cannot run inside a
      // transaction, so this happens after the row-delete transaction above.
      if (filePath !== ":memory:") {
        yield* db.run(sql`VACUUM`).pipe(Effect.orDie)
      }

      const sizeAfter = filePath !== ":memory:" ? safeSize(filePath) : 0

      // Default `dropFile` to false: the shared `banyancode.db` also holds
      // sessions/memory/projects, so wiping the file would wipe unrelated
      // state. Callers that explicitly want file removal pass dropFile: true.
      let droppedFile = false
      if (input?.dropFile ?? false) {
        if (filePath !== ":memory:") {
          // SQLite holds the DB file open via the live connection. On Windows
          // the unlink fails with EBUSY while that handle is alive; on POSIX
          // unlinking an open file succeeds (the inode stays alive until the
          // last FD closes, so writes continue against the unlinked inode —
          // data loss from the user's perspective). We surface the actual
          // outcome in `droppedFile` instead of swallowing errors silently.
          // ENOENT means the file was already removed; any other error (notably
          // EBUSY on Windows) leaves droppedFile=false and logs a warning.
          let outcome: boolean
          try {
            outcome = yield* Effect.tryPromise({
              try: () => Bun.file(filePath).delete().then(() => true as const),
              catch: () => undefined as never,
            })
          } catch {
            outcome = false
          }
          if (!outcome) {
            droppedFile = false
            yield* Effect.logWarning(
              `codegraph-remove: failed to unlink ${filePath} (Windows EBUSY or other unlink error; the DB file remains on disk until the running app exits)`,
            )
          } else {
            droppedFile = true
          }
        }
      }

      return { sizeBefore, sizeAfter, droppedFile }
    })

    const getMeta = Effect.fn("CodegraphRepo.getMeta")(function* () {
      const row = yield* db
        .select()
        .from(CodegraphMetaTable)
        .where(eq(CodegraphMetaTable.id, "singleton"))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return {
        id: row.id,
        graphBuiltAt: row.graph_built_at,
        graphVersion: row.graph_version,
        graphCoverage: row.graph_coverage,
        totalFiles: row.total_files,
        totalNodes: row.total_nodes,
        totalEdges: row.total_edges,
        schemaVersion: row.schema_version,
        indexedRoot: row.indexed_root ?? undefined,
      }
    })

    const setMeta = Effect.fn("CodegraphRepo.setMeta")(function* (m: CodegraphMeta) {
      yield* db
        .insert(CodegraphMetaTable)
        .values({
          id: m.id,
          graph_built_at: m.graphBuiltAt,
          graph_version: m.graphVersion,
          graph_coverage: m.graphCoverage,
          total_files: m.totalFiles,
          total_nodes: m.totalNodes,
          total_edges: m.totalEdges,
          schema_version: m.schemaVersion,
          indexed_root: m.indexedRoot ?? null,
        })
        .onConflictDoUpdate({
          target: CodegraphMetaTable.id,
          set: {
            graph_built_at: m.graphBuiltAt,
            graph_version: m.graphVersion,
            graph_coverage: m.graphCoverage,
            total_files: m.totalFiles,
            total_nodes: m.totalNodes,
            total_edges: m.totalEdges,
            schema_version: m.schemaVersion,
            indexed_root: m.indexedRoot ?? null,
          },
        })
        .run()
        .pipe(Effect.orDie)
    })

    const putEdges = Effect.fn("CodegraphRepo.putEdges")(function* (edges: CodegraphEdge[]) {
      if (edges.length === 0) return
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          for (let i = 0; i < edges.length; i += MAX_EDGES_PER_INSERT) {
            const batch = edges.slice(i, i + MAX_EDGES_PER_INSERT)
            yield* tx
              .insert(CodegraphEdgesTable)
              .values(
                batch.map((e) => ({
                  id: e.id,
                  from_node_id: e.fromNodeID,
                  to_node_id: e.toNodeID,
                  kind: e.kind,
                })),
              )
              .onConflictDoNothing({
                target: CodegraphEdgesTable.id,
              })
              .run()
              .pipe(Effect.orDie)
          }
        }),
      ).pipe(Effect.orDie)
    })

    // Phase 3: populate `codegraph_nodes.in_degree` from the edges table.
    // One UPDATE-with-correlated-subquery is cheap (one full pass) and the
    // ranker can then read the column directly without a COUNT(*) per
    // candidate during trace().
    const recomputeInDegree = Effect.fn("CodegraphRepo.recomputeInDegree")(function* (input?: { nodeIDs?: readonly string[] }) {
      const nodeIDs = input?.nodeIDs ? [...new Set(input.nodeIDs)] : []
      if (nodeIDs.length === 0) {
        yield* db.run(sql`
          UPDATE \`codegraph_nodes\`
          SET \`in_degree\` = (
            SELECT COUNT(*) FROM \`codegraph_edges\`
            WHERE \`codegraph_edges\`.\`to_node_id\` = \`codegraph_nodes\`.\`id\`
          )
        `).pipe(Effect.orDie)
        return
      }
      for (let i = 0; i < nodeIDs.length; i += 900) {
        const chunk = nodeIDs.slice(i, i + 900)
        yield* db
          .update(CodegraphNodesTable)
          .set({
            in_degree: sql`(
              SELECT COUNT(*) FROM \`codegraph_edges\`
              WHERE \`codegraph_edges\`.\`to_node_id\` = \`codegraph_nodes\`.\`id\`
            )`,
          })
          .where(inArray(CodegraphNodesTable.id, chunk))
          .run()
          .pipe(Effect.orDie)
      }
    })

    // Phase 2: refresh `indexed_at` on a batch of files. Used by the
    // indexer after the parse loop so cache-hit files stop looking "stale"
    // to any consumer that compares mtime to indexed_at. One batched
    // UPDATE avoids per-file round trips.
    const bumpIndexedAt = Effect.fn("CodegraphRepo.bumpIndexedAt")(function* (input: {
      fileIDs: readonly string[]
      indexedAt: number
    }) {
      if (input.fileIDs.length === 0) return
      const chunkSize = 900
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          for (let i = 0; i < input.fileIDs.length; i += chunkSize) {
            const chunk = input.fileIDs.slice(i, i + chunkSize)
            yield* tx
              .update(CodegraphFilesTable)
              .set({ indexed_at: input.indexedAt })
              .where(inArray(CodegraphFilesTable.id, chunk))
              .run()
              .pipe(Effect.orDie)
          }
        }),
      ).pipe(Effect.orDie)
    })

    const bumpVersion = Effect.fn("CodegraphRepo.bumpVersion")(function* (input: {
      eligibleFiles?: number
      scannedFiles?: number
      indexedFiles?: number
      totalFiles?: number
      totalNodes?: number
      totalEdges?: number
      indexedRoot?: string
    }) {
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const row = yield* tx
            .select()
            .from(CodegraphMetaTable)
            .where(eq(CodegraphMetaTable.id, "singleton"))
            .get()
            .pipe(Effect.orDie)
          const nextVersion = (row?.graph_version ?? 0) + 1

          // Phase 0: derive every count from the database directly rather
          // than trust caller-supplied numbers. The previous shape let the
          // build service pass a file count into a node field; we close
          // that hole here and only honor what SQL `COUNT(*)` reports.
          const nodeRow = yield* tx
            .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM codegraph_nodes`)
            .pipe(Effect.orDie)
          const totalNodes = nodeRow?.c ?? 0

          const edgeRow = yield* tx
            .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM codegraph_edges`)
            .pipe(Effect.orDie)
          const totalEdges = edgeRow?.c ?? 0

          const fileRow = yield* tx
            .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM codegraph_files`)
            .pipe(Effect.orDie)
          const totalFilesInGraph = fileRow?.c ?? 0

          // Phase 0: graphCoverage measures "fraction of the repo's
          // eligible candidate files that are present in the graph". The
          // numerator is rows in `codegraph_files` (so a fully-cached rebuild
          // scores 1.0), the denominator is the walker-eligible count, with
          // a guard for empty repos.
          const denominator = input.eligibleFiles ?? input.scannedFiles ?? 0
          const rawCoverage = denominator > 0 ? totalFilesInGraph / denominator : 0
          const coverage = Math.round(rawCoverage * 10000) / 10000

          const meta: CodegraphMeta = {
            id: "singleton",
            graphBuiltAt: Date.now(),
            graphVersion: nextVersion,
            graphCoverage: coverage,
            totalFiles: totalFilesInGraph,
            totalNodes,
            totalEdges,
            // Phase 3: the schema gained `is_entrypoint` and `in_degree`
            // columns on codegraph_nodes. Bump the schemaVersion so
            // consumers that compare against it can detect stale graphs.
            schemaVersion: CODEGRAPH_SCHEMA_VERSION,
            indexedRoot: input.indexedRoot ?? row?.indexed_root ?? undefined,
          }

          yield* tx
            .insert(CodegraphMetaTable)
            .values({
              id: meta.id,
              graph_built_at: meta.graphBuiltAt,
              graph_version: meta.graphVersion,
              graph_coverage: meta.graphCoverage,
              total_files: meta.totalFiles,
              total_nodes: meta.totalNodes,
              total_edges: meta.totalEdges,
              schema_version: meta.schemaVersion,
              indexed_root: meta.indexedRoot ?? null,
            })
            .onConflictDoUpdate({
              target: CodegraphMetaTable.id,
              set: {
                graph_built_at: meta.graphBuiltAt,
                graph_version: meta.graphVersion,
                graph_coverage: meta.graphCoverage,
                total_files: meta.totalFiles,
                total_nodes: meta.totalNodes,
                total_edges: meta.totalEdges,
                schema_version: meta.schemaVersion,
                indexed_root: meta.indexedRoot ?? null,
              },
            })
            .run()
            .pipe(Effect.orDie)

          return {
            graphVersion: nextVersion,
            coverage,
            totalNodes,
            totalEdges,
            // Phase 1: surface the meta row fields the status pill needs so the
            // terminal publish doesn't have to re-read them from the DB. The
            // build event already knows totalFiles/graphBuiltAt at this point
            // because they were just written into `CodegraphMeta` above.
            totalFiles: totalFilesInGraph,
            graphBuiltAt: meta.graphBuiltAt,
          }
        })
      ).pipe(Effect.orDie)
    })

    const recordParseError = Effect.fn("CodegraphRepo.recordParseError")(function* (input: { path: string; cause: string; indexedAt: number }) {
      // Don't swallow the error — let it propagate so indexer callers can log
      // and the row is actually inserted. Surface unexpected failures rather
      // than silently losing parse-error visibility.
      yield* db
        .insert(CodegraphParseErrorsTable)
        .values({ path: input.path, cause: input.cause, indexed_at: input.indexedAt })
        .run()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning(`codegraph.recordParseError failed for ${input.path}`, { cause: Cause.pretty(cause) })
              return yield* Effect.failCause(cause)
            }),
          ),
        )
    })

    const listParseErrors = Effect.fn("CodegraphRepo.listParseErrors")(function* () {
      const rows = yield* db
        .select()
        .from(CodegraphParseErrorsTable)
        .orderBy(sql`${CodegraphParseErrorsTable.indexed_at} DESC`)
        .limit(500)
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({ path: row.path, cause: row.cause, indexedAt: row.indexed_at }))
    })

    const clearParseErrors = Effect.fn("CodegraphRepo.clearParseErrors")(function* () {
      yield* db.delete(CodegraphParseErrorsTable).run().pipe(Effect.ignore)
    })

    const lookupByServiceTag = Effect.fn("CodegraphRepo.lookupByServiceTag")(function* (tag: string) {
      const rows = yield* db
        .select()
        .from(CodegraphServiceTagsTable)
        .where(eq(CodegraphServiceTagsTable.tag, tag))
        .limit(1)
        .all()
        .pipe(Effect.orDie)

      if (rows.length === 0) return null

      const node = yield* getNode(rows[0]!.node_id)
      return node ?? null
    })

    const findSymbolsByServiceTag = Effect.fn("CodegraphRepo.findSymbolsByServiceTag")(function* (tag: string) {
      const indexed = yield* lookupByServiceTag(tag)
      if (indexed) return [indexed]

      const stripped = tag.replace(/^@[^/]+(\/[^/]+)*\//, "").replace(/^@/, "")
      const candidates = [stripped, stripped.replace(/Service$/, ""), "Service"].filter(
        (s, i, arr) => arr.indexOf(s) === i,
      )
      const likes = candidates.map((c) => sql`code LIKE ${"%" + c + "%"}`)
      const whereClause = sql.join(likes, sql` OR `)

      const rows = yield* db
        .select()
        .from(CodegraphNodesTable)
        .where(sql`(kind = 'class') AND (code LIKE '%Context.Service%') AND (${whereClause})`)
        .all()
        .pipe(Effect.orDie)
      const mapped = rows.map(rowToNode)
      const normalize = (s: string) => s.replace(/Service$/, "").toLowerCase()
      return mapped.filter((n) => {
        if (!n.code) return false
        const match = n.code.match(/Context\.Service\s*<[\s\S]*?>\s*\(\s*\)\s*\(\s*["']([^"']+)["']\s*\)/)
        if (!match) return false
        const tagString = match[1]
        const tagStripped = tagString.replace(/^@[^/]+(\/[^/]+)*\//, "").replace(/^@/, "")
        return normalize(tagStripped) === normalize(stripped)
      })
    })

    const fileIDsByServiceName = Effect.fn("CodegraphRepo.fileIDsByServiceName")(function* (serviceName: string) {
      const rows = yield* db
        .select({ file_id: CodegraphServiceTagsTable.file_id })
        .from(CodegraphServiceTagsTable)
        .where(eq(CodegraphServiceTagsTable.service_name, serviceName))
        .all()
        .pipe(Effect.orDie)
      const ids = new Set<string>()
      for (const row of rows) ids.add(row.file_id)
      return [...ids]
    })

    const rebuildFtsIndex = Effect.fn("CodegraphRepo.rebuildFtsIndex")(function* () {
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.run(sql`DELETE FROM \`codegraph_fts\``)

          yield* tx.run(sql`
            INSERT INTO \`codegraph_fts\`(\`rowid\`, \`name\`, \`signature\`, \`code\`)
            SELECT \`rowid\`, \`name\`, COALESCE(\`signature\`, ''), COALESCE(\`code\`, '')
            FROM \`codegraph_nodes\`
          `)

          const countResult = yield* tx.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM \`codegraph_fts\``)
          return { rowsIndexed: countResult?.c ?? 0 }
        }),
      ).pipe(Effect.orDie)
    })

    const nodeToInsertRow = (n: CodegraphNode) => {
      const rawIsEp = (n as CodegraphNode & { isEntrypoint?: number | boolean | undefined }).isEntrypoint
      const isEntrypoint = rawIsEp ? 1 : 0
      const rawInDeg = (n as CodegraphNode & { inDegree?: number | undefined }).inDegree
      const inDegree = typeof rawInDeg === "number" ? rawInDeg : 0
      return {
        id: n.id,
        file_id: n.fileID,
        kind: n.kind,
        name: n.name,
        signature: n.signature,
        start_line: n.startLine,
        end_line: n.endLine,
        code: n.code,
        is_entrypoint: isEntrypoint,
        in_degree: inDegree,
      }
    }

    const putNodes = Effect.fn("CodegraphRepo.putNodes")(function* (nodes: CodegraphNode[]) {
      if (nodes.length === 0) return
      yield* db
        .insert(CodegraphNodesTable)
        .values(nodes.map(nodeToInsertRow))
        .onConflictDoUpdate({
          target: CodegraphNodesTable.id,
          set: {
            file_id: nodes[0].fileID,
            // Other columns will only diverge from the insert values on the
            // very first conflict (when a node is re-parsed); in that case
            // the caller already wrote the latest values via a transaction
            // that wraps putNodes, so setting file_id here keeps the FK
            // consistent without re-stating every column.
          },
        })
        .run()
        .pipe(Effect.orDie)
    })

    // Single-transaction write of one file's worth of graph data. Replaces
    // the ~15 individual auto-committed writes (deleteFile + putFile +
    // N×putNode + M×putEdge) the indexer used to do per file, which was the
    // primary cause of the 1+ GB WAL during real-workspace builds.
    const writeFileGraph = Effect.fn("CodegraphRepo.writeFileGraph")(function* (input: {
      file: CodegraphFile
      nodes: CodegraphNode[]
      edges: CodegraphEdge[]
      previousFileID?: string
    }) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            // Identity-mismatch defense: `codegraph_files.path` is UNIQUE
            // and the conflict target for the file insert below. Deleting
            // by `previousFileID` alone is unsafe if the row at this path
            // already has a different `id` (e.g. after `clearAll({ dropFile:
            // false })` or a re-index pass that regenerated ids): the
            // subsequent upsert would keep the old id and a node insert
            // with `file_id = input.file.id` would FK-fail. Delete by path
            // so the file row's `ON DELETE CASCADE` wipes any stale edges
            // and nodes regardless of which id was attached.
            //
            // The first delete below only matches service-tag rows whose
            // `file_id` already equals `input.file.id`; it does NOT clean
            // up tags whose `file_id` points at the OLD (mismatched) id.
            // Those stale-tag rows are reconciled below by the
            // `ON CONFLICT (tag) DO UPDATE` upsert, which rewrites the
            // canonical tag row to point at the new node + file id.
            yield* tx
              .delete(CodegraphServiceTagsTable)
              .where(eq(CodegraphServiceTagsTable.file_id, input.file.id))
              .run()
              .pipe(Effect.orDie)
            yield* tx
              .delete(CodegraphFilesTable)
              .where(eq(CodegraphFilesTable.path, input.file.path))
              .run()
              .pipe(Effect.orDie)

            yield* tx
              .insert(CodegraphFilesTable)
              .values({
                id: input.file.id,
                path: input.file.path,
                content_hash: input.file.contentHash,
                language: input.file.language,
                indexed_at: input.file.indexedAt,
                size_bytes: input.file.sizeBytes ?? 0,
                mtime_ms: input.file.mtimeMs ?? 0,
              })
              .onConflictDoUpdate({
                target: CodegraphFilesTable.path,
                set: {
                  // Force the row's `id` to match the new file_id; otherwise
                  // a stale row from a previous pass would retain its old
                  // id and the subsequent node inserts would FK-fail.
                  id: input.file.id,
                  content_hash: input.file.contentHash,
                  language: input.file.language,
                  indexed_at: input.file.indexedAt,
                  size_bytes: input.file.sizeBytes ?? 0,
                  mtime_ms: input.file.mtimeMs ?? 0,
                },
              })
              .run()
              .pipe(Effect.orDie)

            if (input.nodes.length > 0) {
              yield* tx
                .insert(CodegraphNodesTable)
                .values(input.nodes.map(nodeToInsertRow))
                .onConflictDoUpdate({
                  target: CodegraphNodesTable.id,
                  set: {
                    file_id: sql`excluded.file_id`,
                    kind: sql`excluded.kind`,
                    name: sql`excluded.name`,
                    signature: sql`excluded.signature`,
                    start_line: sql`excluded.start_line`,
                    end_line: sql`excluded.end_line`,
                    code: sql`excluded.code`,
                    is_entrypoint: sql`excluded.is_entrypoint`,
                  },
                })
                .run()
                .pipe(Effect.orDie)

              // Skip service-tag extraction entirely for files under test
              // paths. A `*.test.ts` that declares `class MemoryRepo extends
              // Context.Service<…>("@banyancode/MemoryRepo")` is a TEST DOUBLE
              // and must not own the canonical tag — the source `Service` in
              // `memory-repo.ts` should own it. Without this gate, incremental
              // per-file indexing plus the unique `tag` index + last-writer-wins
              // upsert would let whichever test file was reindexed most recently
              // steal the tag row from the source (see P1 in
              // `.banyancode/plans/fix-weak-codegraph-repository-tools.md`).
              const fileIsTest = isTestFilePath(input.file.path)
              const serviceTagEntries = fileIsTest
                ? []
                : input.nodes
                    .map((n) =>
                      n.kind === "class" && !n.id.includes(":artifact:") && n.code
                        ? extractServiceTag(n.code, n.id, n.fileID)
                        : null,
                    )
                    .filter((e): e is NonNullable<typeof e> => e !== null)

              // Wipe any tags already pointing at this file id (e.g. from a
              // previous indexer pass that succeeded partially) so the upsert
              // below doesn't collide with itself.
              if (serviceTagEntries.length > 0) {
                yield* tx
                  .delete(CodegraphServiceTagsTable)
                  .where(eq(CodegraphServiceTagsTable.file_id, input.file.id))
                  .run()
                  .pipe(Effect.orDie)
              }

              // Upsert on the `tag` column (the actual UNIQUE index), not `id`.
              // Two class nodes with different generated ids but the same
              // @banyancode/X tag would otherwise collide and roll back the
              // entire writeFileGraph transaction. Conflict target = tag means
              // the latest indexer pass wins for the canonical service.
              //
              // Plan Phase B B3 (bonus): collapse the per-entry upsert loop
              // into a single multi-row upsert when more than one tag is
              // present. With many Context.Service classes per file (we
              // sometimes see 5+) the per-row writes inside the transaction
              // were the dominant cost — one round trip replaces N.
              if (serviceTagEntries.length === 1) {
                const entry = serviceTagEntries[0]!
                yield* tx
                  .insert(CodegraphServiceTagsTable)
                  .values(entry)
                  .onConflictDoUpdate({
                    target: CodegraphServiceTagsTable.tag,
                    set: {
                      service_name: entry.service_name,
                      file_id: entry.file_id,
                      node_id: entry.node_id,
                      class_name: entry.class_name,
                      indexed_at: entry.indexed_at,
                    },
                  })
                  .run()
                  .pipe(Effect.orDie)
              } else if (serviceTagEntries.length > 1) {
                yield* tx
                  .insert(CodegraphServiceTagsTable)
                  .values(serviceTagEntries)
                  .onConflictDoUpdate({
                    target: CodegraphServiceTagsTable.tag,
                    set: {
                      service_name: sql`excluded.service_name`,
                      file_id: sql`excluded.file_id`,
                      node_id: sql`excluded.node_id`,
                      class_name: sql`excluded.class_name`,
                      indexed_at: sql`excluded.indexed_at`,
                    },
                  })
                  .run()
                  .pipe(Effect.orDie)
              }
            }

            if (input.edges.length > 0) {
              yield* tx
                .insert(CodegraphEdgesTable)
                .values(
                  input.edges.map((e) => ({
                    id: e.id,
                    from_node_id: e.fromNodeID,
                    to_node_id: e.toNodeID,
                    kind: e.kind,
                  })),
                )
                .onConflictDoNothing({
                  target: CodegraphEdgesTable.id,
                })
                .run()
                .pipe(Effect.orDie)
            }
          }),
        )
        .pipe(Effect.orDie)
    })

    return Service.of({
      putFile,
      getFile,
      getFileByPath,
      listAllFiles,
      putNode,
      putNodes,
      getNode,
      nodeByID,
      nodesByIDs,
      listNodesByFile,
      listNodesByKind,
      listAllNodes,
      queryNodes,
      searchNodes,
      searchNodesLight,
      ftsSearchNodes,
      nodesByFileIDs,
      dependentsOfFiles,
      filesByIDs,
      countNodes,
      countEdges,
      countFiles,
      countStaleFiles,
      listToolUsage,
      putEdge,
      putEdges,
      getEdge,
      listAllEdges,
      listEdgesByNode,
      edgesFrom,
      edgesTo,
      edgesFromBatch,
      edgesToBatch,
      deleteFile,
      deleteDerivedEdgesForFiles,
      deleteAllDerivedEdges,
      writeFileGraph,
      clearAll,
      getMeta,
      setMeta,
      bumpVersion,
      recordParseError,
      listParseErrors,
      clearParseErrors,
      findSymbolsByServiceTag,
      lookupByServiceTag,
      fileIDsByServiceName,
      rebuildFtsIndex,
      recomputeInDegree,
      bumpIndexedAt,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

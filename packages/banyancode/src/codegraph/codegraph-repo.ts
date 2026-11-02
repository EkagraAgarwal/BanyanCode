/**
 * Codegraph repository — raw-SQL port of v1
 * `packages/core/src/banyancode/codegraph-repo.ts`.
 *
 * v2 differences:
 *   - drizzle `Database.Service` → the plugin `Storage.Service` (raw SQL on the
 *     project's `banyancode-<hash>.db`). `Storage.query` is the parameterised
 *     path; multi-statement DDL goes through `Storage.exec`.
 *   - Transactions are `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` on the shared
 *     connection, serialised in-process with a semaphore so two concurrent
 *     tool calls can never interleave a transaction. SQLite's own write lock
 *     covers cross-process contention (`busy_timeout = 5000`).
 *   - The FTS5 table is `codegraph_nodes_fts` (external-content FTS5 over
 *     `codegraph_nodes`, created by the v2 storage migration). The v1 table
 *     was `codegraph_fts` + manual rebuild; v2 uses the migration's triggers.
 *
 * Interface shape, SQL semantics and the v1 lessons (COUNT not SELECT *,
 * explicit skip buckets, atomic read-modify-write) are preserved.
 */
import { Cause, Effect, Exit, Semaphore } from "effect"
import { statSync } from "node:fs"
import type { Storage } from "../storage/index.js"
import { isTestFilePath } from "./codegraph-paths.js"
import type { CodegraphEdge, CodegraphFile, CodegraphMeta, CodegraphNode } from "./types.js"
import { isWithinRoot } from "./workspace-identity.js"

export type FTSResult = CodegraphNode & { readonly bm25: number }

export const MAX_NODES_PER_INSERT = 1000
const MAX_EDGES_PER_INSERT = 5000

/** Single source of truth for the codegraph meta schema version. */
export const CODEGRAPH_SCHEMA_VERSION = 5

/** Split an identifier-ish query into lowercase tokens for FTS5. */
export const expandQueryToTokens = (query: string): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const piece of query.split(/\s+/).filter(Boolean)) {
    const camelSplit = piece.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    for (const t of camelSplit.split(/[^A-Za-z0-9]+/).filter(Boolean)) {
      const lower = t.toLowerCase()
      if (lower.length < 3) continue
      if (seen.has(lower)) continue
      seen.add(lower)
      out.push(lower)
    }
  }
  return out
}

type ServiceTagRow = {
  id: string
  tag: string
  service_name: string
  file_id: string
  node_id: string
  class_name: string
  indexed_at: number
}

const extractServiceTag = (code: string, nodeID: string, fileID: string): ServiceTagRow | null => {
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
  const tail = code.slice(j)
  const tagMatch = tail.match(/^\s*\(\s*\)\s*\(\s*["']([^"']+)["']\s*\)/)
  if (!tagMatch) return null
  const tag = tagMatch[1]!
  return {
    id: `${nodeID}:${tag}`,
    tag,
    service_name: tag.split("/").pop() ?? tag,
    file_id: fileID,
    node_id: nodeID,
    class_name: "Service",
    indexed_at: Date.now(),
  }
}

const safeSize = (path: string): number => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

const DERIVED_EDGE_KINDS = [
  "calls",
  "extends",
  "references",
  "tested_by",
  "configured_by",
  "built_by",
  "mounts",
  "generated_from",
] as const

const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(", ")

export interface Interface {
  readonly putFile: (file: CodegraphFile) => Effect.Effect<void>
  readonly getFile: (id: string) => Effect.Effect<CodegraphFile | undefined>
  readonly getFileByPath: (path: string) => Effect.Effect<CodegraphFile | undefined>
  readonly listAllFiles: () => Effect.Effect<CodegraphFile[]>
  readonly listFilesPage: (input: {
    cursor?: string
    limit?: number
  }) => Effect.Effect<{ files: CodegraphFile[]; nextCursor: string | undefined }>
  readonly putNode: (node: CodegraphNode) => Effect.Effect<void>
  readonly putNodes: (nodes: CodegraphNode[]) => Effect.Effect<void>
  readonly getNode: (id: string) => Effect.Effect<CodegraphNode | undefined>
  readonly nodeByID: (id: string) => Effect.Effect<CodegraphNode | undefined>
  readonly nodesByIDs: (ids: string[]) => Effect.Effect<CodegraphNode[]>
  readonly listNodesByFile: (fileID: string) => Effect.Effect<CodegraphNode[]>
  readonly listNodesByKind: (kind: string) => Effect.Effect<CodegraphNode[]>
  readonly listAllNodes: () => Effect.Effect<CodegraphNode[]>
  readonly listNodesPage: (input: {
    cursor?: string
    limit?: number
  }) => Effect.Effect<{ nodes: CodegraphNode[]; nextCursor: string | undefined }>
  readonly queryNodes: (input: { function?: string; kind?: string }) => Effect.Effect<CodegraphNode[]>
  readonly searchNodes: (input: { name?: string; kind?: string; limit?: number }) => Effect.Effect<CodegraphNode[]>
  readonly searchNodesLight: (input: {
    name?: string
    kind?: string
    fileID?: string
    limit?: number
  }) => Effect.Effect<Array<Omit<CodegraphNode, "code"> & { code?: never }>>
  readonly ftsSearchNodes: (input: { query: string; limit?: number }) => Effect.Effect<FTSResult[]>
  readonly nodesByFileIDs: (input: { fileIDs: string[] }) => Effect.Effect<CodegraphNode[]>
  readonly dependentsOfFiles: (input: {
    fileIDs: readonly string[]
    limit?: number
  }) => Effect.Effect<readonly string[]>
  readonly filesByIDs: (ids: ReadonlyArray<string>) => Effect.Effect<CodegraphFile[]>
  readonly countNodes: () => Effect.Effect<number>
  readonly countEdges: () => Effect.Effect<number>
  readonly countFiles: () => Effect.Effect<number>
  readonly countStaleFiles: () => Effect.Effect<number>
  readonly listStaleFiles: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<{ path: string; mtimeMs: number; indexedAt: number }>>
  readonly listToolUsage: (input?: {
    session?: string
  }) => Effect.Effect<ReadonlyArray<{ toolId: string; useCount: number; lastUsedAt: number }>>
  readonly putEdge: (edge: CodegraphEdge) => Effect.Effect<void>
  readonly putEdges: (edges: CodegraphEdge[]) => Effect.Effect<void>
  readonly getEdge: (id: string) => Effect.Effect<CodegraphEdge | undefined>
  readonly listAllEdges: () => Effect.Effect<CodegraphEdge[]>
  readonly listEdgesPage: (input: {
    cursor?: string
    limit?: number
  }) => Effect.Effect<{ edges: CodegraphEdge[]; nextCursor: string | undefined }>
  readonly listEdgesByNode: (nodeID: string) => Effect.Effect<CodegraphEdge[]>
  readonly edgesFrom: (nodeID: string) => Effect.Effect<CodegraphEdge[]>
  readonly edgesTo: (nodeID: string) => Effect.Effect<CodegraphEdge[]>
  readonly edgesFromBatch: (ids: ReadonlyArray<string>) => Effect.Effect<CodegraphEdge[]>
  readonly edgesToBatch: (ids: ReadonlyArray<string>) => Effect.Effect<CodegraphEdge[]>
  readonly deleteFile: (id: string) => Effect.Effect<void>
  readonly deleteDerivedEdgesForFiles: (input: {
    fileIDs: string[]
    preserveEdgeIDs?: ReadonlySet<string>
  }) => Effect.Effect<readonly string[]>
  readonly deleteAllDerivedEdges: (preserveEdgeIDs?: ReadonlySet<string>) => Effect.Effect<readonly string[]>
  readonly writeFileGraph: (input: {
    file: CodegraphFile
    nodes: CodegraphNode[]
    edges: CodegraphEdge[]
    previousFileID?: string
  }) => Effect.Effect<void>
  /**
   * Deletes every graph row, rebuilds the FTS index, VACUUMs the file and
   * truncates the WAL. `dropFile` requests the strongest reset; because the
   * plugin holds the database open, that means an empty schema rather than an
   * unlinked file (`droppedFile` is always false).
   */
  readonly clearAll: (input?: { dropFile?: boolean }) => Effect.Effect<{
    sizeBefore: number
    sizeAfter: number
    droppedFile: boolean
  }>
  readonly recomputeInDegree: (input?: { nodeIDs?: readonly string[] }) => Effect.Effect<void>
  readonly bumpIndexedAt: (input: { fileIDs: readonly string[]; indexedAt: number }) => Effect.Effect<void>
  readonly getMeta: () => Effect.Effect<CodegraphMeta | undefined>
  readonly setMeta: (m: CodegraphMeta) => Effect.Effect<void>
  readonly bumpVersion: (input: {
    eligibleFiles?: number
    scannedFiles?: number
    indexedFiles?: number
    totalFiles?: number
    totalNodes?: number
    totalEdges?: number
    indexedRoot?: string
  }) => Effect.Effect<{
    graphVersion: number
    coverage: number
    totalNodes: number
    totalEdges: number
    totalFiles: number
    graphBuiltAt: number
  }>
  readonly recordParseError: (input: { path: string; cause: string; indexedAt: number }) => Effect.Effect<void, unknown>
  readonly listParseErrors: () => Effect.Effect<Array<{ path: string; cause: string; indexedAt: number }>>
  readonly clearParseErrors: () => Effect.Effect<void>
  readonly findSymbolsByServiceTag: (tag: string) => Effect.Effect<CodegraphNode[]>
  readonly lookupByServiceTag: (tag: string) => Effect.Effect<CodegraphNode | null>
  readonly fileIDsByServiceName: (serviceName: string) => Effect.Effect<readonly string[]>
  readonly rebuildFtsIndex: () => Effect.Effect<{ rowsIndexed: number }>
}

type FileRow = {
  id: string
  path: string
  content_hash: string
  language: string
  indexed_at: number
  size_bytes: number
  mtime_ms: number
}

type NodeRow = {
  id: string
  file_id: string
  kind: string
  name: string
  signature: string | null
  start_line: number
  end_line: number
  code: string | null
  is_entrypoint: number
  in_degree: number
}

type EdgeRow = { id: string; from_node_id: string; to_node_id: string; kind: string }

const rowToFile = (row: FileRow): CodegraphFile => ({
  id: row.id,
  path: row.path,
  contentHash: row.content_hash,
  language: row.language,
  indexedAt: row.indexed_at,
  sizeBytes: row.size_bytes,
  mtimeMs: row.mtime_ms,
})

const rowToNode = (row: NodeRow): CodegraphNode =>
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
  }) as CodegraphNode

const rowToEdge = (row: EdgeRow): CodegraphEdge => ({
  id: row.id,
  fromNodeID: row.from_node_id,
  toNodeID: row.to_node_id,
  kind: row.kind as CodegraphEdge["kind"],
})

const nodeToRow = (n: CodegraphNode) => [
  n.id,
  n.fileID,
  n.kind,
  n.name,
  n.signature ?? null,
  n.startLine,
  n.endLine,
  n.code ?? null,
  n.isEntrypoint ? 1 : 0,
  typeof n.inDegree === "number" ? n.inDegree : 0,
] as const

const NODE_INSERT_COLUMNS =
  "id, file_id, kind, name, signature, start_line, end_line, code, is_entrypoint, in_degree"

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[])
  return out
}

/** Builds the repository bound to one project database. */
export const make = (storage: Storage.Interface): Interface => {
  // Serialises the BEGIN/COMMIT pairs on the shared connection. SQLite itself
  // would serialise writes, but two in-process `BEGIN IMMEDIATE` blocks can
  // still interleave their statements and commit each other's work.
  const txGate = Semaphore.makeUnsafe(1)

  const run = (sql: string, params: readonly unknown[] = []): Effect.Effect<void, never> =>
    storage.query(sql, params).pipe(Effect.asVoid, Effect.orDie)

  const all = <A>(sql: string, params: readonly unknown[] = []): Effect.Effect<readonly A[], never> =>
    storage.query<A>(sql, params).pipe(Effect.orDie)

  const get = <A>(sql: string, params: readonly unknown[] = []): Effect.Effect<A | undefined, never> =>
    storage.query<A>(sql, params).pipe(
      Effect.map((rows) => rows[0]),
      Effect.orDie,
    )

  const count = (sql: string): Effect.Effect<number, never> =>
    get<{ c: number }>(sql).pipe(Effect.map((row) => row?.c ?? 0))

  // COMMIT on success, ROLLBACK on failure or interruption. `onExit` keeps
  // the original exit (including interrupts from cancel()), so a wedged build
  // being interrupted never turns into a defect.
  const transaction = <A>(effect: Effect.Effect<A>): Effect.Effect<A> =>
    txGate.withPermits(1)(
      Effect.gen(function* () {
        yield* run("BEGIN IMMEDIATE")
        return yield* effect
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? run("COMMIT")
            : run("ROLLBACK").pipe(Effect.ignore),
        ),
      ),
    ).pipe(Effect.orDie)

  const putFile: Interface["putFile"] = (file) =>
    run(
      `INSERT INTO codegraph_files (id, path, content_hash, language, indexed_at, size_bytes, mtime_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         content_hash = excluded.content_hash,
         language = excluded.language,
         indexed_at = excluded.indexed_at,
         size_bytes = excluded.size_bytes,
         mtime_ms = excluded.mtime_ms`,
      [
        file.id,
        file.path,
        file.contentHash,
        file.language,
        file.indexedAt,
        file.sizeBytes ?? 0,
        file.mtimeMs ?? 0,
      ],
    )

  const getFile: Interface["getFile"] = (id) =>
    get<FileRow>("SELECT * FROM codegraph_files WHERE id = ?", [id]).pipe(
      Effect.map((row) => (row ? rowToFile(row) : undefined)),
    )

  const getFileByPath: Interface["getFileByPath"] = (path) =>
    get<FileRow>("SELECT * FROM codegraph_files WHERE path = ?", [path]).pipe(
      Effect.map((row) => (row ? rowToFile(row) : undefined)),
    )

  const listFilesPage: Interface["listFilesPage"] = (input) =>
    Effect.gen(function* () {
      const limit = Math.min(Math.max(input.limit ?? 500, 1), 5000)
      const rows =
        input.cursor !== undefined
          ? yield* all<FileRow>(
              "SELECT * FROM codegraph_files WHERE id > ? ORDER BY id ASC LIMIT ?",
              [input.cursor, limit],
            )
          : yield* all<FileRow>("SELECT * FROM codegraph_files ORDER BY id ASC LIMIT ?", [limit])
      return {
        files: rows.map(rowToFile),
        nextCursor: rows.length === limit ? rows.at(-1)?.id : undefined,
      }
    })

  const listAllFiles: Interface["listAllFiles"] = () =>
    Effect.gen(function* () {
      const allFiles: CodegraphFile[] = []
      let cursor: string | undefined
      for (;;) {
        const page = yield* listFilesPage({ ...(cursor !== undefined ? { cursor } : {}), limit: 1000 })
        for (const file of page.files) allFiles.push(file)
        if (page.nextCursor === undefined) break
        cursor = page.nextCursor
      }
      return allFiles
    })

  const putNodes: Interface["putNodes"] = (nodes) =>
    nodes.length === 0
      ? Effect.void
      : transaction(
          Effect.forEach(
            chunk(nodes, MAX_NODES_PER_INSERT),
            (batch) =>
              run(
                `INSERT INTO codegraph_nodes (${NODE_INSERT_COLUMNS}) VALUES ${batch
                  .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
                  .join(", ")}
                 ON CONFLICT(id) DO UPDATE SET
                   file_id = excluded.file_id,
                   kind = excluded.kind,
                   name = excluded.name,
                   signature = excluded.signature,
                   start_line = excluded.start_line,
                   end_line = excluded.end_line,
                   code = excluded.code,
                   is_entrypoint = excluded.is_entrypoint`,
                batch.flatMap(nodeToRow),
              ),
            { discard: true },
          ),
        )

  const putNode: Interface["putNode"] = (node) => putNodes([node])

  const getNode: Interface["getNode"] = (id) =>
    get<NodeRow>("SELECT * FROM codegraph_nodes WHERE id = ?", [id]).pipe(
      Effect.map((row) => (row ? rowToNode(row) : undefined)),
    )

  const nodeByID: Interface["nodeByID"] = (id) => getNode(id)

  const nodesByIDs: Interface["nodesByIDs"] = (ids) =>
    Effect.gen(function* () {
      if (ids.length === 0) return []
      const rows: NodeRow[] = []
      for (const batch of chunk([...new Set(ids)], 900)) {
        rows.push(...(yield* all<NodeRow>(`SELECT * FROM codegraph_nodes WHERE id IN (${placeholders(batch.length)})`, batch)))
      }
      return rows.map(rowToNode)
    })

  const listNodesByFile: Interface["listNodesByFile"] = (fileID) =>
    all<NodeRow>("SELECT * FROM codegraph_nodes WHERE file_id = ?", [fileID]).pipe(Effect.map((rows) => rows.map(rowToNode)))

  const listNodesByKind: Interface["listNodesByKind"] = (kind) =>
    all<NodeRow>("SELECT * FROM codegraph_nodes WHERE kind = ?", [kind]).pipe(Effect.map((rows) => rows.map(rowToNode)))

  const listNodesPage: Interface["listNodesPage"] = (input) =>
    Effect.gen(function* () {
      const limit = Math.min(Math.max(input.limit ?? 500, 1), 5000)
      const rows =
        input.cursor !== undefined
          ? yield* all<NodeRow>("SELECT * FROM codegraph_nodes WHERE id > ? ORDER BY id ASC LIMIT ?", [
              input.cursor,
              limit,
            ])
          : yield* all<NodeRow>("SELECT * FROM codegraph_nodes ORDER BY id ASC LIMIT ?", [limit])
      return {
        nodes: rows.map(rowToNode),
        nextCursor: rows.length === limit ? rows.at(-1)?.id : undefined,
      }
    })

  const listAllNodes: Interface["listAllNodes"] = () =>
    Effect.gen(function* () {
      const nodes: CodegraphNode[] = []
      let cursor: string | undefined
      for (;;) {
        const page = yield* listNodesPage({ ...(cursor !== undefined ? { cursor } : {}), limit: 1000 })
        for (const node of page.nodes) nodes.push(node)
        if (page.nextCursor === undefined) break
        cursor = page.nextCursor
      }
      return nodes
    })

  const queryNodes: Interface["queryNodes"] = (input) =>
    Effect.gen(function* () {
      const where: string[] = []
      const params: unknown[] = []
      if (input.function) {
        where.push("name = ?")
        params.push(input.function)
      }
      if (input.kind) {
        where.push("kind = ?")
        params.push(input.kind)
      }
      if (where.length === 0) return []
      const rows = yield* all<NodeRow>(`SELECT * FROM codegraph_nodes WHERE ${where.join(" AND ")}`, params)
      return rows.map(rowToNode)
    })

  const searchNodes: Interface["searchNodes"] = (input) =>
    Effect.gen(function* () {
      const limit = input.limit ?? 1000
      const where: string[] = []
      const params: unknown[] = []
      if (input.name) {
        where.push("name LIKE ?")
        params.push("%" + input.name + "%")
      }
      if (input.kind) {
        where.push("kind = ?")
        params.push(input.kind)
      }
      const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
      const rows = yield* all<NodeRow>(
        `SELECT * FROM codegraph_nodes ${clause} ORDER BY codegraph_nodes.name LIMIT ?`,
        [...params, limit],
      )
      return rows.map(rowToNode)
    })

  const searchNodesLight: Interface["searchNodesLight"] = (input) =>
    Effect.gen(function* () {
      const limit = input.limit ?? 1000
      const where: string[] = []
      const params: unknown[] = []
      if (input.name) {
        where.push("name LIKE ?")
        params.push("%" + input.name + "%")
      }
      if (input.kind) {
        where.push("kind = ?")
        params.push(input.kind)
      }
      if (input.fileID) {
        where.push("file_id = ?")
        params.push(input.fileID)
      }
      const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
      const rows = yield* all<Omit<NodeRow, "code"> & { code?: string }>(
        `SELECT id, file_id, kind, name, signature, start_line, end_line
         FROM codegraph_nodes ${clause} ORDER BY codegraph_nodes.name LIMIT ?`,
        [...params, limit],
      )
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

  const ftsSearchNodes: Interface["ftsSearchNodes"] = (input) =>
    Effect.gen(function* () {
      const limit = input.limit ?? 50
      const sanitized = input.query.replace(/["'()*:\-]/g, " ").trim()
      if (!sanitized) return []
      const tokens = expandQueryToTokens(sanitized)
      if (tokens.length === 0) return []
      const quote = (t: string) => `"${t}"`
      const andQuery = tokens.map(quote).join(" AND ")
      const orQuery = tokens.map(quote).join(" OR ")
      type FTSRow = NodeRow & { bm25: number }
      const runFts = (match: string) =>
        all<FTSRow>(
          `SELECT n.id, n.file_id, n.kind, n.name, n.signature, n.start_line, n.end_line, n.code,
                  n.is_entrypoint, n.in_degree,
                  bm25(codegraph_nodes_fts, 10.0, 3.0, 1.0) AS bm25
           FROM codegraph_nodes_fts
           INNER JOIN codegraph_nodes n ON n.rowid = codegraph_nodes_fts.rowid
           WHERE codegraph_nodes_fts MATCH ?
           ORDER BY bm25
           LIMIT ?`,
          [match, limit],
        ).pipe(Effect.catchCause(() => Effect.succeed([] as FTSRow[])))

      const rows =
        tokens.length >= 2
          ? yield* Effect.gen(function* () {
              const andRows = yield* runFts(andQuery)
              return andRows.length > 0 ? andRows : yield* runFts(orQuery)
            })
          : yield* runFts(orQuery)
      return rows.map((row) => ({ ...rowToNode(row), bm25: row.bm25 }))
    })

  const nodesByFileIDs: Interface["nodesByFileIDs"] = (input) =>
    Effect.gen(function* () {
      if (input.fileIDs.length === 0) return []
      const rows: NodeRow[] = []
      for (const batch of chunk([...new Set(input.fileIDs)], 900)) {
        rows.push(
          ...(yield* all<NodeRow>(
            `SELECT * FROM codegraph_nodes WHERE file_id IN (${placeholders(batch.length)})`,
            batch,
          )),
        )
      }
      return rows.map(rowToNode)
    })

  const filesByIDs: Interface["filesByIDs"] = (ids) =>
    Effect.gen(function* () {
      if (ids.length === 0) return []
      const rows: FileRow[] = []
      for (const batch of chunk([...new Set(ids)], 900)) {
        rows.push(
          ...(yield* all<FileRow>(`SELECT * FROM codegraph_files WHERE id IN (${placeholders(batch.length)})`, batch)),
        )
      }
      return rows.map(rowToFile)
    })

  const putEdges: Interface["putEdges"] = (edges) =>
    edges.length === 0
      ? Effect.void
      : transaction(
          Effect.forEach(
            chunk(edges, MAX_EDGES_PER_INSERT),
            (batch) =>
              run(
                `INSERT INTO codegraph_edges (id, from_node_id, to_node_id, kind) VALUES ${batch
                  .map(() => "(?, ?, ?, ?)")
                  .join(", ")} ON CONFLICT(id) DO NOTHING`,
                batch.flatMap((e) => [e.id, e.fromNodeID, e.toNodeID, e.kind]),
              ),
            { discard: true },
          ),
        )

  const putEdge: Interface["putEdge"] = (edge) => putEdges([edge])

  const getEdge: Interface["getEdge"] = (id) =>
    get<EdgeRow>("SELECT * FROM codegraph_edges WHERE id = ?", [id]).pipe(
      Effect.map((row) => (row ? rowToEdge(row) : undefined)),
    )

  const listEdgesPage: Interface["listEdgesPage"] = (input) =>
    Effect.gen(function* () {
      const limit = Math.min(Math.max(input.limit ?? 500, 1), 5000)
      const rows =
        input.cursor !== undefined
          ? yield* all<EdgeRow>("SELECT * FROM codegraph_edges WHERE id > ? ORDER BY id ASC LIMIT ?", [
              input.cursor,
              limit,
            ])
          : yield* all<EdgeRow>("SELECT * FROM codegraph_edges ORDER BY id ASC LIMIT ?", [limit])
      return {
        edges: rows.map(rowToEdge),
        nextCursor: rows.length === limit ? rows.at(-1)?.id : undefined,
      }
    })

  const listAllEdges: Interface["listAllEdges"] = () =>
    Effect.gen(function* () {
      const edges: CodegraphEdge[] = []
      let cursor: string | undefined
      for (;;) {
        const page = yield* listEdgesPage({ ...(cursor !== undefined ? { cursor } : {}), limit: 1000 })
        for (const edge of page.edges) edges.push(edge)
        if (page.nextCursor === undefined) break
        cursor = page.nextCursor
      }
      return edges
    })

  const listEdgesByNode: Interface["listEdgesByNode"] = (nodeID) =>
    all<EdgeRow>("SELECT * FROM codegraph_edges WHERE from_node_id = ?", [nodeID]).pipe(
      Effect.map((rows) => rows.map(rowToEdge)),
    )

  const edgesFrom: Interface["edgesFrom"] = (nodeID) => listEdgesByNode(nodeID)

  const edgesTo: Interface["edgesTo"] = (nodeID) =>
    all<EdgeRow>("SELECT * FROM codegraph_edges WHERE to_node_id = ?", [nodeID]).pipe(
      Effect.map((rows) => rows.map(rowToEdge)),
    )

  const edgesFromBatch: Interface["edgesFromBatch"] = (ids) =>
    Effect.gen(function* () {
      if (ids.length === 0) return []
      const rows: EdgeRow[] = []
      for (const batch of chunk([...new Set(ids)], 900)) {
        rows.push(
          ...(yield* all<EdgeRow>(
            `SELECT * FROM codegraph_edges WHERE from_node_id IN (${placeholders(batch.length)})`,
            batch,
          )),
        )
      }
      return rows.map(rowToEdge)
    })

  const edgesToBatch: Interface["edgesToBatch"] = (ids) =>
    Effect.gen(function* () {
      if (ids.length === 0) return []
      const rows: EdgeRow[] = []
      for (const batch of chunk([...new Set(ids)], 900)) {
        rows.push(
          ...(yield* all<EdgeRow>(
            `SELECT * FROM codegraph_edges WHERE to_node_id IN (${placeholders(batch.length)})`,
            batch,
          )),
        )
      }
      return rows.map(rowToEdge)
    })

  const deleteFile: Interface["deleteFile"] = (id) =>
    transaction(
      Effect.gen(function* () {
        yield* run("DELETE FROM codegraph_service_tags WHERE file_id = ?", [id])
        yield* run("DELETE FROM codegraph_files WHERE id = ?", [id])
      }),
    )

  const deleteDerivedEdgesForFiles: Interface["deleteDerivedEdgesForFiles"] = (input) =>
    Effect.gen(function* () {
      if (input.fileIDs.length === 0) return []
      const nodeIDs: string[] = []
      for (const batch of chunk([...new Set(input.fileIDs)], 900)) {
        const rows = yield* all<{ id: string }>(
          `SELECT id FROM codegraph_nodes WHERE file_id IN (${placeholders(batch.length)})`,
          batch,
        )
        for (const row of rows) nodeIDs.push(row.id)
      }
      if (nodeIDs.length === 0) return []
      return yield* transaction(
        Effect.gen(function* () {
          const kinds = DERIVED_EDGE_KINDS.map(() => "?").join(", ")
          const preserve = input.preserveEdgeIDs && input.preserveEdgeIDs.size > 0 ? [...input.preserveEdgeIDs] : []
          const preserveClause = preserve.length > 0 ? ` AND id NOT IN (${placeholders(preserve.length)})` : ""
          const touched = new Set<string>(nodeIDs)
          for (const batch of chunk(nodeIDs, 900)) {
            const idPlaceholders = placeholders(batch.length)
            const rows = yield* all<{ from_node_id: string; to_node_id: string }>(
              `SELECT from_node_id, to_node_id FROM codegraph_edges
               WHERE (from_node_id IN (${idPlaceholders}) OR to_node_id IN (${idPlaceholders}))
                 AND kind IN (${kinds})${preserveClause}`,
              [...batch, ...batch, ...DERIVED_EDGE_KINDS, ...preserve],
            )
            for (const row of rows) {
              touched.add(row.from_node_id)
              touched.add(row.to_node_id)
            }
            yield* run(
              `DELETE FROM codegraph_edges
               WHERE (from_node_id IN (${idPlaceholders}) OR to_node_id IN (${idPlaceholders}))
                 AND kind IN (${kinds})${preserveClause}`,
              [...batch, ...batch, ...DERIVED_EDGE_KINDS, ...preserve],
            )
          }
          return [...touched]
        }),
      )
    })

  const deleteAllDerivedEdges: Interface["deleteAllDerivedEdges"] = (preserveEdgeIDs) =>
    transaction(
      Effect.gen(function* () {
        const kinds = DERIVED_EDGE_KINDS.map(() => "?").join(", ")
        const preserve = preserveEdgeIDs && preserveEdgeIDs.size > 0 ? [...preserveEdgeIDs] : []
        const preserveClause = preserve.length > 0 ? ` AND id NOT IN (${placeholders(preserve.length)})` : ""
        const params = [...DERIVED_EDGE_KINDS, ...preserve]
        const rows = yield* all<{ from_node_id: string; to_node_id: string }>(
          `SELECT from_node_id, to_node_id FROM codegraph_edges WHERE kind IN (${kinds})${preserveClause}`,
          params,
        )
        yield* run(`DELETE FROM codegraph_edges WHERE kind IN (${kinds})${preserveClause}`, params)
        const touched = new Set<string>()
        for (const row of rows) {
          touched.add(row.from_node_id)
          touched.add(row.to_node_id)
        }
        return [...touched]
      }),
    )

  const dependentsOfFiles: Interface["dependentsOfFiles"] = (input) =>
    Effect.gen(function* () {
      const fileIDs = [...new Set(input.fileIDs)]
      const limit = input.limit === undefined ? undefined : Math.max(0, Math.floor(input.limit))
      if (fileIDs.length === 0 || limit === 0) return []
      const changedNodes = yield* nodesByFileIDs({ fileIDs })
      if (changedNodes.length === 0) return []
      const changedNodeIDs = changedNodes.map((node) => node.id)
      const [fromEdges, toEdges] = yield* Effect.all([
        edgesFromBatch(changedNodeIDs),
        edgesToBatch(changedNodeIDs),
      ])
      const otherNodeIDs = new Set<string>()
      for (const edge of fromEdges) otherNodeIDs.add(edge.toNodeID)
      for (const edge of toEdges) otherNodeIDs.add(edge.fromNodeID)
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

  const clearAll: Interface["clearAll"] = (input) =>
    Effect.gen(function* () {
      const filePath = storage.path
      const sizeBefore = filePath !== ":memory:" ? safeSize(filePath) : 0
      yield* transaction(
        Effect.gen(function* () {
          for (const table of [
            "codegraph_service_tags",
            "codegraph_traces",
            "codegraph_parse_errors",
            "codegraph_meta",
            "codegraph_edges",
            "codegraph_nodes",
            "codegraph_files",
            "codegraph_tool_usage",
          ]) {
            yield* run(`DELETE FROM ${table}`)
          }
          // FTS5 external-content tables are maintained by triggers on
          // codegraph_nodes, so deleting the rows rebuilds them naturally.
          yield* run("INSERT INTO codegraph_nodes_fts (codegraph_nodes_fts) VALUES ('rebuild')")
        }),
      )
      // VACUUM rebuilds the file, but in WAL mode the rewritten pages land in
      // the WAL first: the main file only shrinks after a checkpoint that
      // FOLLOWS the vacuum. Checkpointing before it (the old order) left
      // sizeAfter === sizeBefore and reported freedBytes 0.
      if (filePath !== ":memory:") {
        yield* storage.exec("VACUUM").pipe(Effect.ignore)
        yield* storage.exec("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.ignore)
      }
      const sizeAfter = filePath !== ":memory:" ? safeSize(filePath) : 0
      if (input?.dropFile ?? false) {
        // Never unlink a database that still has a live connection: POSIX
        // keeps writing into the unlinked inode (the next build reports
        // success but persists nothing) and Windows refuses the unlink
        // (EBUSY) while the command printed a green check. The VACUUM +
        // checkpoint above already drained every row and truncated the WAL,
        // so the file on disk is an empty schema — a build right after writes
        // real data into it.
        yield* storage.exec("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.ignore)
        const remaining = yield* get<{ count: number }>("SELECT COUNT(*) AS count FROM codegraph_nodes")
        if ((remaining?.count ?? 0) > 0) {
          yield* Effect.logWarning("codegraph-remove: the graph still has nodes after --drop-file; the file was kept")
        }
      }
      return { sizeBefore, sizeAfter, droppedFile: false }
    })

  const recomputeInDegree: Interface["recomputeInDegree"] = (input) => {
    const nodeIDs = input?.nodeIDs ? [...new Set(input.nodeIDs)] : []
    if (nodeIDs.length === 0) {
      return run(
        `UPDATE codegraph_nodes SET in_degree = (
           SELECT COUNT(*) FROM codegraph_edges WHERE codegraph_edges.to_node_id = codegraph_nodes.id
         )`,
      )
    }
    return Effect.forEach(
      chunk(nodeIDs, 900),
      (batch) =>
        run(
          `UPDATE codegraph_nodes SET in_degree = (
             SELECT COUNT(*) FROM codegraph_edges WHERE codegraph_edges.to_node_id = codegraph_nodes.id
           ) WHERE id IN (${placeholders(batch.length)})`,
          batch,
        ),
      { discard: true },
    )
  }

  const bumpIndexedAt: Interface["bumpIndexedAt"] = (input) =>
    input.fileIDs.length === 0
      ? Effect.void
      : Effect.forEach(
          chunk([...new Set(input.fileIDs)], 900),
          (batch) =>
            run(`UPDATE codegraph_files SET indexed_at = ? WHERE id IN (${placeholders(batch.length)})`, [
              input.indexedAt,
              ...batch,
            ]),
          { discard: true },
        )

  const readMeta = get<{
    id: string
    graph_built_at: number
    graph_version: number
    graph_coverage: number
    total_files: number
    total_nodes: number
    total_edges: number
    schema_version: number
    indexed_root: string | null
  }>("SELECT * FROM codegraph_meta WHERE id = 'singleton'")

  const getMeta: Interface["getMeta"] = () =>
    readMeta.pipe(
      Effect.map((row) =>
        row
          ? {
              graphBuiltAt: row.graph_built_at,
              graphVersion: row.graph_version,
              graphCoverage: row.graph_coverage,
              totalFiles: row.total_files,
              totalNodes: row.total_nodes,
              totalEdges: row.total_edges,
              schemaVersion: row.schema_version,
              indexedRoot: row.indexed_root ?? undefined,
            }
          : undefined,
      ),
    )

  const writeMeta = (m: CodegraphMeta): Effect.Effect<void> =>
    run(
      `INSERT INTO codegraph_meta
         (id, graph_built_at, graph_version, graph_coverage, total_files, total_nodes, total_edges, schema_version, indexed_root)
       VALUES ('singleton', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         graph_built_at = excluded.graph_built_at,
         graph_version = excluded.graph_version,
         graph_coverage = excluded.graph_coverage,
         total_files = excluded.total_files,
         total_nodes = excluded.total_nodes,
         total_edges = excluded.total_edges,
         schema_version = excluded.schema_version,
         indexed_root = excluded.indexed_root`,
      [
        m.graphBuiltAt,
        m.graphVersion,
        m.graphCoverage,
        m.totalFiles,
        m.totalNodes,
        m.totalEdges,
        m.schemaVersion,
        m.indexedRoot ?? null,
      ],
    )

  const setMeta: Interface["setMeta"] = (m) => writeMeta(m)

  const bumpVersion: Interface["bumpVersion"] = (input) =>
    transaction(
      Effect.gen(function* () {
        const row = yield* readMeta
        const nextVersion = (row?.graph_version ?? 0) + 1
        const totalNodes = yield* count("SELECT COUNT(*) AS c FROM codegraph_nodes")
        const totalEdges = yield* count("SELECT COUNT(*) AS c FROM codegraph_edges")
        const totalFilesInGraph = yield* count("SELECT COUNT(*) AS c FROM codegraph_files")
        const denominator = input.eligibleFiles ?? input.scannedFiles ?? 0
        const coverage = denominator > 0 ? Math.round((totalFilesInGraph / denominator) * 10000) / 10000 : 0
        const meta: CodegraphMeta = {
          graphBuiltAt: Date.now(),
          graphVersion: nextVersion,
          graphCoverage: coverage,
          totalFiles: totalFilesInGraph,
          totalNodes,
          totalEdges,
          schemaVersion: CODEGRAPH_SCHEMA_VERSION,
          indexedRoot:
            row?.indexed_root && input.indexedRoot && isWithinRoot(input.indexedRoot, row.indexed_root)
              ? row.indexed_root
              : (input.indexedRoot ?? row?.indexed_root ?? undefined),
        }
        yield* writeMeta(meta)
        return {
          graphVersion: nextVersion,
          coverage,
          totalNodes,
          totalEdges,
          totalFiles: totalFilesInGraph,
          graphBuiltAt: meta.graphBuiltAt,
        }
      }),
    )

  const recordParseError: Interface["recordParseError"] = (input) =>
    run("INSERT INTO codegraph_parse_errors (path, cause, indexed_at) VALUES (?, ?, ?)", [
      input.path,
      input.cause,
      input.indexedAt,
    ]).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(`codegraph.recordParseError failed for ${input.path}`, { cause: Cause.pretty(cause) })
          return yield* Effect.failCause(cause)
        }),
      ),
    )

  const listParseErrors: Interface["listParseErrors"] = () =>
    all<{ path: string; cause: string; indexed_at: number }>(
      "SELECT path, cause, indexed_at FROM codegraph_parse_errors ORDER BY indexed_at DESC LIMIT 500",
    ).pipe(Effect.map((rows) => rows.map((row) => ({ path: row.path, cause: row.cause, indexedAt: row.indexed_at }))))

  const clearParseErrors: Interface["clearParseErrors"] = () =>
    run("DELETE FROM codegraph_parse_errors").pipe(Effect.ignore)

  const lookupByServiceTag: Interface["lookupByServiceTag"] = (tag) =>
    get<ServiceTagRow>("SELECT * FROM codegraph_service_tags WHERE tag = ? LIMIT 1", [tag]).pipe(
      Effect.flatMap((row) => (row ? getNode(row.node_id) : Effect.succeed(undefined))),
      Effect.map((node) => node ?? null),
    )

  const findSymbolsByServiceTag: Interface["findSymbolsByServiceTag"] = (tag) =>
    Effect.gen(function* () {
      const indexed = yield* lookupByServiceTag(tag)
      if (indexed) return [indexed]
      const stripped = tag.replace(/^@[^/]+(\/[^/]+)*\//, "").replace(/^@/, "")
      const candidates = [stripped, stripped.replace(/Service$/, ""), "Service"].filter(
        (s, i, arr) => arr.indexOf(s) === i,
      )
      const likes = candidates.map(() => "code LIKE ?").join(" OR ")
      const rows = yield* all<NodeRow>(
        `SELECT * FROM codegraph_nodes
         WHERE kind = 'class' AND code LIKE '%Context.Service%' AND (${likes})`,
        candidates.map((c) => "%" + c + "%"),
      )
      const normalize = (s: string) => s.replace(/Service$/, "").toLowerCase()
      return rows.map(rowToNode).filter((n) => {
        if (!n.code) return false
        const match = n.code.match(/Context\.Service\s*<[\s\S]*?>\s*\(\s*\)\s*\(\s*["']([^"']+)["']\s*\)/)
        if (!match) return false
        const tagStripped = match[1]!.replace(/^@[^/]+(\/[^/]+)*\//, "").replace(/^@/, "")
        return normalize(tagStripped) === normalize(stripped)
      })
    })

  const fileIDsByServiceName: Interface["fileIDsByServiceName"] = (serviceName) =>
    all<{ file_id: string }>(
      "SELECT DISTINCT file_id FROM codegraph_service_tags WHERE service_name = ?",
      [serviceName],
    ).pipe(Effect.map((rows) => rows.map((row) => row.file_id)))

  const rebuildFtsIndex: Interface["rebuildFtsIndex"] = () =>
    transaction(
      Effect.gen(function* () {
        yield* run("INSERT INTO codegraph_nodes_fts (codegraph_nodes_fts) VALUES ('rebuild')")
        const row = yield* get<{ c: number }>("SELECT COUNT(*) AS c FROM codegraph_nodes_fts")
        return { rowsIndexed: row?.c ?? 0 }
      }),
    )

  const writeFileGraph: Interface["writeFileGraph"] = (input) =>
    transaction(
      Effect.gen(function* () {
        yield* run("DELETE FROM codegraph_service_tags WHERE file_id = ?", [input.file.id])
        // Delete by path too: `codegraph_files.path` is UNIQUE, so a row left
        // over from an earlier pass may carry a different id. Deleting by path
        // cascades its nodes/edges instead of tripping the FK on insert.
        yield* run("DELETE FROM codegraph_files WHERE path = ?", [input.file.path])
        yield* run(
          `INSERT INTO codegraph_files (id, path, content_hash, language, indexed_at, size_bytes, mtime_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             id = excluded.id,
             content_hash = excluded.content_hash,
             language = excluded.language,
             indexed_at = excluded.indexed_at,
             size_bytes = excluded.size_bytes,
             mtime_ms = excluded.mtime_ms`,
          [
            input.file.id,
            input.file.path,
            input.file.contentHash,
            input.file.language,
            input.file.indexedAt,
            input.file.sizeBytes ?? 0,
            input.file.mtimeMs ?? 0,
          ],
        )
        for (const batch of chunk(input.nodes, MAX_NODES_PER_INSERT)) {
          yield* run(
            `INSERT INTO codegraph_nodes (${NODE_INSERT_COLUMNS}) VALUES ${batch
              .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .join(", ")}
             ON CONFLICT(id) DO UPDATE SET
               file_id = excluded.file_id,
               kind = excluded.kind,
               name = excluded.name,
               signature = excluded.signature,
               start_line = excluded.start_line,
               end_line = excluded.end_line,
               code = excluded.code,
               is_entrypoint = excluded.is_entrypoint`,
            batch.flatMap(nodeToRow),
          )
        }
        const fileIsTest = isTestFilePath(input.file.path)
        const tags = fileIsTest
          ? []
          : input.nodes
              .map((n) =>
                n.kind === "class" && !n.id.includes(":artifact:") && n.code
                  ? extractServiceTag(n.code, n.id, n.fileID)
                  : null,
              )
              .filter((e): e is ServiceTagRow => e !== null)
        if (tags.length > 0) {
          yield* run("DELETE FROM codegraph_service_tags WHERE file_id = ?", [input.file.id])
          yield* run(
            `INSERT INTO codegraph_service_tags (id, tag, service_name, file_id, node_id, class_name, indexed_at)
             VALUES ${tags.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}
             ON CONFLICT(tag) DO UPDATE SET
               service_name = excluded.service_name,
               file_id = excluded.file_id,
               node_id = excluded.node_id,
               class_name = excluded.class_name,
               indexed_at = excluded.indexed_at`,
            tags.flatMap((t) => [t.id, t.tag, t.service_name, t.file_id, t.node_id, t.class_name, t.indexed_at]),
          )
        }
        for (const batch of chunk(input.edges, MAX_EDGES_PER_INSERT)) {
          yield* run(
            `INSERT INTO codegraph_edges (id, from_node_id, to_node_id, kind) VALUES ${batch
              .map(() => "(?, ?, ?, ?)")
              .join(", ")} ON CONFLICT(id) DO NOTHING`,
            batch.flatMap((e) => [e.id, e.fromNodeID, e.toNodeID, e.kind]),
          )
        }
      }),
    )

  return {
    putFile,
    getFile,
    getFileByPath,
    listAllFiles,
    listFilesPage,
    putNode,
    putNodes,
    getNode,
    nodeByID,
    nodesByIDs,
    listNodesByFile,
    listNodesByKind,
    listAllNodes,
    listNodesPage,
    queryNodes,
    searchNodes,
    searchNodesLight,
    ftsSearchNodes,
    nodesByFileIDs,
    dependentsOfFiles,
    filesByIDs,
    countNodes: () => count("SELECT COUNT(*) AS c FROM codegraph_nodes"),
    countEdges: () => count("SELECT COUNT(*) AS c FROM codegraph_edges"),
    countFiles: () => count("SELECT COUNT(*) AS c FROM codegraph_files"),
    countStaleFiles: () => count("SELECT COUNT(*) AS c FROM codegraph_files WHERE mtime_ms > indexed_at"),
    listStaleFiles: (limit) =>
      all<{ path: string; mtime_ms: number; indexed_at: number }>(
        "SELECT path, mtime_ms, indexed_at FROM codegraph_files WHERE mtime_ms > indexed_at ORDER BY mtime_ms DESC LIMIT ?",
        [limit],
      ).pipe(Effect.map((rows) => rows.map((row) => ({ path: row.path, mtimeMs: row.mtime_ms, indexedAt: row.indexed_at })))),
    listToolUsage: (input) =>
      all<{ tool_id: string; use_count: number; last_used_at: number }>(
        `SELECT tool_id, use_count, last_used_at FROM codegraph_tool_usage
         ${input?.session !== undefined ? "WHERE session_id = ?" : ""}
         ORDER BY use_count DESC LIMIT 50`,
        input?.session !== undefined ? [input.session] : [],
      ).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({ toolId: row.tool_id, useCount: row.use_count, lastUsedAt: row.last_used_at })),
        ),
      ),
    putEdge,
    putEdges,
    getEdge,
    listAllEdges,
    listEdgesPage,
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
    recomputeInDegree,
    bumpIndexedAt,
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
  }
}

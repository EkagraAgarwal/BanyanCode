export * as CodegraphRepo from "./codegraph-repo"

import { and, eq, inArray, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { CodegraphEdgesTable, CodegraphFilesTable, CodegraphNodesTable } from "./codegraph.sql"
import { CodegraphMetaTable } from "./codegraph-meta.sql"
import { CodegraphParseErrorsTable } from "./codegraph-parse-errors.sql"
import type { CodegraphEdge, CodegraphFile, CodegraphMeta, CodegraphNode } from "./types"

// Upper bound on nodes per DB insert batch. If a batched putNodes method is added,
// chunk the input into groups of this size to avoid overwhelming the SQLite connection.
export const MAX_NODES_PER_INSERT = 1000
const MAX_EDGES_PER_INSERT = 1000

const safeSize = (path: string): number => {
  try {
    return Bun.file(path).size ?? 0
  } catch {
    return 0
  }
}

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
  readonly listAllNodes: () => Effect.Effect<CodegraphNode[], never, never>
  readonly queryNodes: (input: { function?: string; kind?: string }) => Effect.Effect<CodegraphNode[], never, never>
  readonly searchNodes: (input: { name?: string; kind?: string; limit?: number }) => Effect.Effect<CodegraphNode[], never, never>
  readonly countNodes: () => Effect.Effect<number, never, never>
  readonly countEdges: () => Effect.Effect<number, never, never>
  readonly countFiles: () => Effect.Effect<number, never, never>
  readonly putEdge: (edge: CodegraphEdge) => Effect.Effect<void, never, never>
  readonly putEdges: (edges: CodegraphEdge[]) => Effect.Effect<void, never, never>
  readonly getEdge: (id: string) => Effect.Effect<CodegraphEdge | undefined, never, never>
  readonly listAllEdges: () => Effect.Effect<CodegraphEdge[], never, never>
  readonly listEdgesByNode: (nodeID: string) => Effect.Effect<CodegraphEdge[], never, never>
  readonly edgesFrom: (nodeID: string) => Effect.Effect<CodegraphEdge[], never, never>
  readonly edgesTo: (nodeID: string) => Effect.Effect<CodegraphEdge[], never, never>
  readonly deleteFile: (id: string) => Effect.Effect<void, never, never>
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
  ) => Effect.Effect<{ sizeBefore: number; sizeAfter: number }, never, never>
  readonly getMeta: () => Effect.Effect<CodegraphMeta | undefined, never, never>
  readonly setMeta: (m: CodegraphMeta) => Effect.Effect<void, never, never>
  readonly bumpVersion: (input: {
    scannedFiles: number
    indexedFiles: number
    totalFiles: number
    totalNodes: number
    totalEdges: number
  }) => Effect.Effect<{ graphVersion: number; coverage: number }, never, never>
  readonly recordParseError: (input: { path: string; cause: string; indexedAt: number }) => Effect.Effect<void, never, never>
  readonly listParseErrors: () => Effect.Effect<Array<{ path: string; cause: string; indexedAt: number }>, never, never>
  readonly clearParseErrors: () => Effect.Effect<void, never, never>
  readonly findSymbolsByServiceTag: (tag: string) => Effect.Effect<CodegraphNode[], never, never>
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
        })
        .onConflictDoUpdate({
          target: CodegraphFilesTable.path,
          set: {
            content_hash: file.contentHash,
            language: file.language,
            indexed_at: file.indexedAt,
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
      }))
    })

    const putNode = Effect.fn("CodegraphRepo.putNode")(function* (node: CodegraphNode) {
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
      }
    })

    const listNodesByFile = Effect.fn("CodegraphRepo.listNodesByFile")(function* (fileID: string) {
      const rows = yield* db
        .select()
        .from(CodegraphNodesTable)
        .where(eq(CodegraphNodesTable.file_id, fileID))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        fileID: row.file_id,
        kind: row.kind as CodegraphNode["kind"],
        name: row.name,
        signature: row.signature ?? undefined,
        startLine: row.start_line,
        endLine: row.end_line,
        code: row.code ?? undefined,
      }))
    })

    const listAllNodes = Effect.fn("CodegraphRepo.listAllNodes")(function* () {
      const rows = yield* db.select().from(CodegraphNodesTable).all().pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        fileID: row.file_id,
        kind: row.kind as CodegraphNode["kind"],
        name: row.name,
        signature: row.signature ?? undefined,
        startLine: row.start_line,
        endLine: row.end_line,
        code: row.code ?? undefined,
      }))
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
      yield* db.delete(CodegraphFilesTable).where(eq(CodegraphFilesTable.id, id)).run().pipe(Effect.orDie)
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
      return allRows.map((row) => ({
        id: row.id,
        fileID: row.file_id,
        kind: row.kind as CodegraphNode["kind"],
        name: row.name,
        signature: row.signature ?? undefined,
        startLine: row.start_line,
        endLine: row.end_line,
        code: row.code ?? undefined,
      }))
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
      return rows.map((row) => ({
        id: row.id,
        fileID: row.file_id,
        kind: row.kind as CodegraphNode["kind"],
        name: row.name,
        signature: row.signature ?? undefined,
        startLine: row.start_line,
        endLine: row.end_line,
        code: row.code ?? undefined,
      }))
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
      return rows.map((row) => ({
        id: row.id,
        fileID: row.file_id,
        kind: row.kind as CodegraphNode["kind"],
        name: row.name,
        signature: row.signature ?? undefined,
        startLine: row.start_line,
        endLine: row.end_line,
        code: row.code ?? undefined,
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

    const clearAll = Effect.fn("CodegraphRepo.clearAll")(function* (input?: { dropFile?: boolean }) {
      const filePath = Database.path()
      const sizeBefore = filePath !== ":memory:" ? safeSize(filePath) : 0

      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(CodegraphEdgesTable).run().pipe(Effect.orDie)
            yield* tx.delete(CodegraphNodesTable).run().pipe(Effect.orDie)
            yield* tx.delete(CodegraphFilesTable).run().pipe(Effect.orDie)
            yield* tx.delete(CodegraphMetaTable).run().pipe(Effect.orDie)
            yield* tx.delete(CodegraphParseErrorsTable).run().pipe(Effect.orDie)
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
      if (input?.dropFile ?? false) {
        if (filePath !== ":memory:") {
          // SQLite holds the DB file open via the live connection. On Windows
          // the unlink fails with EBUSY while that handle is alive; on POSIX
          // unlinking an open file succeeds (the inode stays alive until the
          // last FD closes). We treat EBUSY as best-effort: the data is wiped
          // which is the main goal, and the file will be removed when the app
          // restarts or the DB connection closes. ENOENT means already gone.
          yield* Effect.tryPromise({
            try: () =>
              Bun.file(filePath).delete().catch((err: unknown) => {
                const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : ""
                if (code === "ENOENT" || code === "EBUSY") return
                throw err
              }),
            catch: (err) => err,
          }).pipe(Effect.orDie)
        }
      }

      return { sizeBefore, sizeAfter }
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
              .onConflictDoUpdate({
                target: CodegraphEdgesTable.id,
                set: {
                  from_node_id: batch[0].fromNodeID,
                  to_node_id: batch[0].toNodeID,
                  kind: batch[0].kind,
                },
              })
              .run()
              .pipe(Effect.orDie)
          }
        }),
      ).pipe(Effect.orDie)
    })

    const bumpVersion = Effect.fn("CodegraphRepo.bumpVersion")(function* (input: {
      scannedFiles: number
      indexedFiles: number
      totalFiles: number
      totalNodes: number
      totalEdges: number
    }) {
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const fileRow = yield* tx
            .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM codegraph_files`)
            .pipe(Effect.orDie)
          const indexedFilesCount = fileRow?.c ?? 0
          const coverage = input.scannedFiles > 0 ? indexedFilesCount / input.scannedFiles : 0
          
          const row = yield* tx
            .select()
            .from(CodegraphMetaTable)
            .where(eq(CodegraphMetaTable.id, "singleton"))
            .get()
            .pipe(Effect.orDie)
          const nextVersion = (row?.graph_version ?? 0) + 1
          
          const nodeRow = yield* tx
            .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM codegraph_nodes`)
            .pipe(Effect.orDie)
          const totalNodes = nodeRow?.c ?? 0

          const edgeRow = yield* tx
            .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM codegraph_edges`)
            .pipe(Effect.orDie)
          const totalEdges = edgeRow?.c ?? 0

          const meta: CodegraphMeta = {
            id: "singleton",
            graphBuiltAt: Date.now(),
            graphVersion: nextVersion,
            graphCoverage: coverage,
            totalFiles: input.totalFiles,
            totalNodes,
            totalEdges,
            schemaVersion: 1,
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
              },
            })
            .run()
            .pipe(Effect.orDie)

          return { graphVersion: nextVersion, coverage }
        })
      ).pipe(Effect.orDie)
    })

    const recordParseError = Effect.fn("CodegraphRepo.recordParseError")(function* (input: { path: string; cause: string; indexedAt: number }) {
      yield* db
        .insert(CodegraphParseErrorsTable)
        .values({ path: input.path, cause: input.cause, indexed_at: input.indexedAt })
        .run()
        .pipe(Effect.ignore)
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

    const findSymbolsByServiceTag = Effect.fn("CodegraphRepo.findSymbolsByServiceTag")(function* (tag: string) {
      const stripped = tag.replace(/^@[^/]+(\/[^/]+)*\//, "").replace(/^@/, "")
      // Triple filter to suppress false positives on bare substring matches:
      // 1. substring contains the bare service name (e.g., "MemoryRepo")
      // 2. kind='class' excludes doc/test/config/docker/etc. nodes
      // 3. code contains "Context.Service" — the registration pattern itself
      const rows = yield* db
        .select()
        .from(CodegraphNodesTable)
        .where(sql`(code LIKE ${"%" + stripped + "%"}) AND kind = 'class' AND (code LIKE '%Context.Service%')`)
        .all()
        .pipe(Effect.orDie)
      const mapped = rows.map((row) => ({
        id: row.id,
        fileID: row.file_id,
        kind: row.kind as CodegraphNode["kind"],
        name: row.name,
        signature: row.signature ?? undefined,
        startLine: row.start_line,
        endLine: row.end_line,
        code: row.code ?? undefined,
      }))
      return mapped.filter((n) => {
        if (!n.code) return false
        const match = n.code.match(/Context\.Service\s*<[\s\S]*?>\s*\(\s*\)\s*\(\s*["']([^"']+)["']\s*\)/)
        if (!match) return false
        const tagString = match[1]
        const tagStripped = tagString.replace(/^@[^/]+(\/[^/]+)*\//, "").replace(/^@/, "")
        return tagStripped.toLowerCase() === stripped.toLowerCase()
      })
    })

    const putNodes = Effect.fn("CodegraphRepo.putNodes")(function* (nodes: CodegraphNode[]) {
      if (nodes.length === 0) return
      yield* db
        .insert(CodegraphNodesTable)
        .values(
          nodes.map((n) => ({
            id: n.id,
            file_id: n.fileID,
            kind: n.kind,
            name: n.name,
            signature: n.signature,
            start_line: n.startLine,
            end_line: n.endLine,
            code: n.code,
          })),
        )
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
            if (input.previousFileID) {
              yield* tx
                .delete(CodegraphFilesTable)
                .where(eq(CodegraphFilesTable.id, input.previousFileID))
                .run()
                .pipe(Effect.orDie)
            }
            yield* tx
              .insert(CodegraphFilesTable)
              .values({
                id: input.file.id,
                path: input.file.path,
                content_hash: input.file.contentHash,
                language: input.file.language,
                indexed_at: input.file.indexedAt,
              })
              .onConflictDoUpdate({
                target: CodegraphFilesTable.path,
                set: {
                  content_hash: input.file.contentHash,
                  language: input.file.language,
                  indexed_at: input.file.indexedAt,
                },
              })
              .run()
              .pipe(Effect.orDie)

            if (input.nodes.length > 0) {
              yield* tx
                .insert(CodegraphNodesTable)
                .values(
                  input.nodes.map((n) => ({
                    id: n.id,
                    file_id: n.fileID,
                    kind: n.kind,
                    name: n.name,
                    signature: n.signature,
                    start_line: n.startLine,
                    end_line: n.endLine,
                    code: n.code,
                  })),
                )
                .onConflictDoUpdate({
                  target: CodegraphNodesTable.id,
                  set: {
                    file_id: input.nodes[0].fileID,
                    kind: input.nodes[0].kind,
                    name: input.nodes[0].name,
                    signature: input.nodes[0].signature,
                    start_line: input.nodes[0].startLine,
                    end_line: input.nodes[0].endLine,
                    code: input.nodes[0].code,
                  },
                })
                .run()
                .pipe(Effect.orDie)
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
                .onConflictDoUpdate({
                  target: CodegraphEdgesTable.id,
                  set: {
                    from_node_id: input.edges[0].fromNodeID,
                    to_node_id: input.edges[0].toNodeID,
                    kind: input.edges[0].kind,
                  },
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
      listAllNodes,
      queryNodes,
      searchNodes,
      countNodes,
      countEdges,
      countFiles,
      putEdge,
      putEdges,
      getEdge,
      listAllEdges,
      listEdgesByNode,
      edgesFrom,
      edgesTo,
      deleteFile,
      writeFileGraph,
      clearAll,
      getMeta,
      setMeta,
      bumpVersion,
      recordParseError,
      listParseErrors,
      clearParseErrors,
      findSymbolsByServiceTag,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

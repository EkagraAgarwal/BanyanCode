export * as CodegraphRepo from "./codegraph-repo"

import { eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { CodegraphEdgesTable, CodegraphFilesTable, CodegraphNodesTable } from "./codegraph.sql"
import { CodegraphMetaTable } from "./codegraph-meta.sql"
import type { CodegraphEdge, CodegraphFile, CodegraphMeta, CodegraphNode } from "./types"

// Upper bound on nodes per DB insert batch. If a batched putNodes method is added,
// chunk the input into groups of this size to avoid overwhelming the SQLite connection.
export const MAX_NODES_PER_INSERT = 1000

export interface Interface {
  readonly putFile: (file: CodegraphFile) => Effect.Effect<void, never, never>
  readonly getFile: (id: string) => Effect.Effect<CodegraphFile | undefined, never, never>
  readonly getFileByPath: (path: string) => Effect.Effect<CodegraphFile | undefined, never, never>
  readonly listAllFiles: () => Effect.Effect<CodegraphFile[], never, never>
  readonly putNode: (node: CodegraphNode) => Effect.Effect<void, never, never>
  readonly getNode: (id: string) => Effect.Effect<CodegraphNode | undefined, never, never>
  readonly nodeByID: (id: string) => Effect.Effect<CodegraphNode | undefined, never, never>
  readonly listNodesByFile: (fileID: string) => Effect.Effect<CodegraphNode[], never, never>
  readonly listAllNodes: () => Effect.Effect<CodegraphNode[], never, never>
  readonly queryNodes: (input: { function?: string; kind?: string }) => Effect.Effect<CodegraphNode[], never, never>
  readonly searchNodes: (input: { name?: string; kind?: string; limit?: number }) => Effect.Effect<CodegraphNode[], never, never>
  readonly countNodes: () => Effect.Effect<number, never, never>
  readonly countEdges: () => Effect.Effect<number, never, never>
  readonly countFiles: () => Effect.Effect<number, never, never>
  readonly putEdge: (edge: CodegraphEdge) => Effect.Effect<void, never, never>
  readonly getEdge: (id: string) => Effect.Effect<CodegraphEdge | undefined, never, never>
  readonly listAllEdges: () => Effect.Effect<CodegraphEdge[], never, never>
  readonly listEdgesByNode: (nodeID: string) => Effect.Effect<CodegraphEdge[], never, never>
  readonly edgesFrom: (nodeID: string) => Effect.Effect<CodegraphEdge[], never, never>
  readonly edgesTo: (nodeID: string) => Effect.Effect<CodegraphEdge[], never, never>
  readonly deleteFile: (id: string) => Effect.Effect<void, never, never>
  readonly clearAll: () => Effect.Effect<void, never, never>
  readonly getMeta: () => Effect.Effect<CodegraphMeta | undefined, never, never>
  readonly setMeta: (m: CodegraphMeta) => Effect.Effect<void, never, never>
  readonly bumpVersion: (input: {
    scannedFiles: number
    indexedFiles: number
    totalFiles: number
    totalNodes: number
    totalEdges: number
  }) => Effect.Effect<{ graphVersion: number; coverage: number }, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Banyan/CodegraphRepo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const putFile = Effect.fn("CodegraphRepo.putFile")(function* (file: CodegraphFile) {
      yield* db.delete(CodegraphFilesTable).where(eq(CodegraphFilesTable.path, file.path)).run().pipe(Effect.orDie)
      yield* db
        .insert(CodegraphFilesTable)
        .values({
          id: file.id,
          path: file.path,
          content_hash: file.contentHash,
          language: file.language,
          indexed_at: file.indexedAt,
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

    const queryNodes = Effect.fn("CodegraphRepo.queryNodes")(function* (input: { function?: string; kind?: string }) {
      const allNodes = yield* listAllNodes()
      return allNodes.filter((n) => {
        if (input.function && n.name === input.function) return true
        if (input.kind && n.kind === input.kind) return true
        return false
      })
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

    const clearAll = Effect.fn("CodegraphRepo.clearAll")(function* () {
      yield* db.delete(CodegraphFilesTable).run().pipe(Effect.orDie)
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

    const bumpVersion = Effect.fn("CodegraphRepo.bumpVersion")(function* (input: {
      scannedFiles: number
      indexedFiles: number
      totalFiles: number
      totalNodes: number
      totalEdges: number
    }) {
      const coverage = input.scannedFiles > 0 ? input.indexedFiles / input.scannedFiles : 0
      const existing = yield* getMeta()
      const nextVersion = (existing?.graphVersion ?? 0) + 1
      const totalNodes = yield* countNodes()
      const totalEdges = yield* countEdges()
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
      yield* setMeta(meta)
      return { graphVersion: nextVersion, coverage }
    })

    return Service.of({
      putFile,
      getFile,
      getFileByPath,
      listAllFiles,
      putNode,
      getNode,
      nodeByID,
      listNodesByFile,
      listAllNodes,
      queryNodes,
      searchNodes,
      countNodes,
      countEdges,
      countFiles,
      putEdge,
      getEdge,
      listAllEdges,
      listEdgesByNode,
      edgesFrom,
      edgesTo,
      deleteFile,
      clearAll,
      getMeta,
      setMeta,
      bumpVersion,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

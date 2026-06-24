export * as CodegraphRepo from "./codegraph-repo"

import { eq, sql, or } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { CodegraphEdgesTable, CodegraphEmbeddingsTable, CodegraphFilesTable, CodegraphNodesTable } from "./codegraph.sql"
import { CodegraphMetaTable } from "./codegraph-meta.sql"
import type { CodegraphEdge, CodegraphFile, CodegraphMeta, CodegraphNode } from "./types"

export class CodegraphSearchError {
  readonly _tag = "CodegraphSearchError" as const
  constructor(readonly message: string) {}
}

export interface Interface {
  readonly putFile: (file: CodegraphFile) => Effect.Effect<void, never, never>
  readonly getFile: (id: string) => Effect.Effect<CodegraphFile | undefined, never, never>
  readonly getFileByPath: (path: string) => Effect.Effect<CodegraphFile | undefined, never, never>
  readonly listAllFiles: () => Effect.Effect<CodegraphFile[], never, never>
  readonly putNode: (node: CodegraphNode) => Effect.Effect<void, never, never>
  readonly getNode: (id: string) => Effect.Effect<CodegraphNode | undefined, never, never>
  readonly nodeByID: (id: string) => Effect.Effect<CodegraphNode | undefined, never, never>
  readonly listNodesByFile: (fileID: string) => Effect.Effect<CodegraphNode[], never, never>
  readonly listAllNodes: (options?: { limit?: number; offset?: number }) => Effect.Effect<CodegraphNode[], never, never>
  readonly queryNodes: (input: { function?: string; kind?: string }) => Effect.Effect<CodegraphNode[], never, never>
  readonly searchNodes: (input: { name?: string; kind?: string; limit?: number }) => Effect.Effect<CodegraphNode[], never, never>
  readonly countNodes: () => Effect.Effect<number, never, never>
  readonly countEdges: () => Effect.Effect<number, never, never>
  readonly countFiles: () => Effect.Effect<number, never, never>
  readonly putEdge: (edge: CodegraphEdge) => Effect.Effect<void, never, never>
  readonly putEdges: (edges: CodegraphEdge[]) => Effect.Effect<void, never, never>
  readonly getEdge: (id: string) => Effect.Effect<CodegraphEdge | undefined, never, never>
  readonly listAllEdges: (options?: { limit?: number; offset?: number }) => Effect.Effect<CodegraphEdge[], never, never>
  readonly listEdgesByNode: (nodeID: string) => Effect.Effect<CodegraphEdge[], never, never>
  readonly edgesFrom: (nodeID: string) => Effect.Effect<CodegraphEdge[], never, never>
  readonly edgesTo: (nodeID: string) => Effect.Effect<CodegraphEdge[], never, never>
  readonly putEmbedding: (nodeID: string, embedding: Uint8Array, model: string, dim: number) => Effect.Effect<void, never, never>
  readonly getEmbedding: (nodeID: string) => Effect.Effect<{ embedding: Uint8Array; model: string; dim: number } | undefined, never, never>
  readonly resetEmbeddingsTable: (
    dim: number,
    model: string,
    options?: { force?: boolean },
  ) => Effect.Effect<void, CodegraphSearchError, never>
  readonly searchByVector: (
    queryVec: Float32Array,
    options?: { limit?: number; model?: string }
  ) => Effect.Effect<Array<{ nodeId: string; distance: number }>, CodegraphSearchError, never>
  readonly deleteFile: (id: string) => Effect.Effect<void, never, never>
  readonly clearAll: () => Effect.Effect<void, never, never>
  readonly getMeta: () => Effect.Effect<CodegraphMeta | undefined, never, never>
  readonly setMeta: (m: CodegraphMeta) => Effect.Effect<void, never, never>
  readonly bumpVersion: (input: {
    scannedFiles: number
    indexedFiles: number
    totalFiles: number
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

    const listAllNodes = Effect.fn("CodegraphRepo.listAllNodes")(function* (options?: { limit?: number; offset?: number }) {
      let limitSql = sql``
      if (options?.limit !== undefined) {
        limitSql = sql` LIMIT ${options.limit}`
        if (options?.offset !== undefined) {
          limitSql = sql`${limitSql} OFFSET ${options.offset}`
        }
      }
      const rows = yield* db
        .all<typeof CodegraphNodesTable.$inferSelect>(sql`
          SELECT * FROM codegraph_nodes
          ${limitSql}
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

    const putEdges = Effect.fn("CodegraphRepo.putEdges")(function* (edges: CodegraphEdge[]) {
      if (edges.length === 0) return
      // Chunk to keep the SQL statement size sane (SQLite has a 999-variable
      // limit per statement and we bind 4 columns per row).
      const CHUNK = 200
      for (let i = 0; i < edges.length; i += CHUNK) {
        const slice = edges.slice(i, i + CHUNK)
        yield* db
          .insert(CodegraphEdgesTable)
          .values(
            slice.map((edge) => ({
              id: edge.id,
              from_node_id: edge.fromNodeID,
              to_node_id: edge.toNodeID,
              kind: edge.kind,
            })),
          )
          .onConflictDoUpdate({
            target: CodegraphEdgesTable.id,
            set: {
              from_node_id: sql`excluded.from_node_id`,
              to_node_id: sql`excluded.to_node_id`,
              kind: sql`excluded.kind`,
            },
          })
          .run()
          .pipe(Effect.orDie)
      }
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

    const listAllEdges = Effect.fn("CodegraphRepo.listAllEdges")(function* (options?: { limit?: number; offset?: number }) {
      let limitSql = sql``
      if (options?.limit !== undefined) {
        limitSql = sql` LIMIT ${options.limit}`
        if (options?.offset !== undefined) {
          limitSql = sql`${limitSql} OFFSET ${options.offset}`
        }
      }
      const rows = yield* db
        .all<typeof CodegraphEdgesTable.$inferSelect>(sql`
          SELECT * FROM codegraph_edges
          ${limitSql}
        `)
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

    const putEmbedding = Effect.fn("CodegraphRepo.putEmbedding")(function* (
      nodeID: string,
      embedding: Uint8Array,
      model: string,
      dim: number,
    ) {
      yield* db
        .insert(CodegraphEmbeddingsTable)
        .values({
          node_id: nodeID,
          embedding,
          model,
          dim,
        })
        .onConflictDoUpdate({
          target: CodegraphEmbeddingsTable.node_id,
          set: {
            embedding,
            model,
            dim,
          },
        })
        .run()
        .pipe(Effect.orDie)
    })

    const getEmbedding = Effect.fn("CodegraphRepo.getEmbedding")(function* (nodeID: string) {
      const row = yield* db
        .select()
        .from(CodegraphEmbeddingsTable)
        .where(eq(CodegraphEmbeddingsTable.node_id, nodeID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return {
        embedding: row.embedding as Uint8Array,
        model: row.model,
        dim: row.dim,
      }
    })

    const clearEmbeddingsForModel = Effect.fn("CodegraphRepo.clearEmbeddingsForModel")(function* (model: string) {
      yield* db
        .delete(CodegraphEmbeddingsTable)
        .where(eq(CodegraphEmbeddingsTable.model, model))
        .run()
        .pipe(Effect.orDie)
    })

    const resetEmbeddingsTable = (
      dim: number,
      model: string,
      options?: { force?: boolean },
    ): Effect.Effect<void, CodegraphSearchError, never> => {
      if (!Number.isInteger(dim) || dim <= 0 || dim > 65536) {
        return Effect.fail(
          new CodegraphSearchError(`Invalid embedding dim: ${dim}. Must be a positive integer <= 65536.`),
        )
      }
      return Effect.gen(function* () {
        const schemaRow = yield* db
          .get<{ sql: string }>(sql`SELECT sql FROM sqlite_schema WHERE type='table' AND name='codegraph_embeddings'`)
          .pipe(Effect.orDie)

        let currentDim = 1536
        if (schemaRow?.sql) {
          const match = schemaRow.sql.match(/F32_BLOB\((\d+)\)/i)
          if (match && match[1]) {
            currentDim = parseInt(match[1], 10)
          }
        }

        if (currentDim !== dim || options?.force === true) {
          yield* db.run(sql`DROP INDEX IF EXISTS codegraph_embedding_model_idx`).pipe(Effect.orDie)
          yield* db.run(sql`DROP INDEX IF EXISTS codegraph_embedding_vec_idx`).pipe(Effect.orDie)
          yield* db.run(sql`DROP TABLE IF EXISTS codegraph_embeddings`).pipe(Effect.orDie)
          yield* db.run(sql`
            CREATE TABLE \`codegraph_embeddings\` (
              \`node_id\` TEXT PRIMARY KEY REFERENCES \`codegraph_nodes\`(\`id\`) ON DELETE CASCADE,
              \`embedding\` F32_BLOB(${sql.raw(String(dim))}) NOT NULL,
              \`model\` TEXT NOT NULL,
              \`dim\` INTEGER NOT NULL,
              \`created_at\` INTEGER NOT NULL DEFAULT (unixepoch())
            )
          `).pipe(Effect.orDie)
          yield* db.run(sql`CREATE INDEX \`codegraph_embedding_model_idx\` ON \`codegraph_embeddings\` (\`model\`)`).pipe(Effect.orDie)
          yield* db.run(sql`CREATE INDEX \`codegraph_embedding_vec_idx\` ON \`codegraph_embeddings\` (libsql_vector_idx(\`embedding\`))`).pipe(Effect.orDie)
        } else {
          yield* clearEmbeddingsForModel(model)
        }

        if (process.env.BANYANCODE_DEBUG === "1") {
          console.error(`[turso.vector] resetEmbeddingsTable dim=${dim} model=${model} force=${options?.force === true}`)
        }
      })
    }

    const searchByVector = (
      queryVec: Float32Array,
      options?: { limit?: number; model?: string },
    ): Effect.Effect<Array<{ nodeId: string; distance: number }>, CodegraphSearchError, never> => {
      const limit = options?.limit ?? 10
      const model = options?.model

      return Effect.gen(function* () {
        // Validate dim matches existing column
        const firstRow = yield* db
          .select({ dim: CodegraphEmbeddingsTable.dim })
          .from(CodegraphEmbeddingsTable)
          .limit(1)
          .get()
          .pipe(Effect.orDie)

        if (firstRow && queryVec.length !== firstRow.dim) {
          return yield* Effect.fail(
            new CodegraphSearchError(`Query vector dim (${queryVec.length}) does not match column dim (${firstRow.dim})`),
          )
        }

        const queryJson = JSON.stringify(Array.from(queryVec))
        const rows = yield* db
          .all<{ node_id: string; distance: number }>(sql`
            SELECT v.node_id, vector_distance_cos(e.embedding, vector32(${sql.raw(queryJson)})) AS distance
            FROM vector_top_k('codegraph_embedding_vec_idx', vector32(${sql.raw(queryJson)}), ${limit}) v
            JOIN codegraph_embeddings e ON e.node_id = v.node_id
            ${model ? sql`WHERE e.model = ${model}` : sql``}
            ORDER BY distance ASC
          `)
          .pipe(Effect.orDie)

        return rows.map((r) => ({ nodeId: r.node_id, distance: r.distance }))
      })
    }

    const deleteFile = Effect.fn("CodegraphRepo.deleteFile")(function* (id: string) {
      yield* db.delete(CodegraphFilesTable).where(eq(CodegraphFilesTable.id, id)).run().pipe(Effect.orDie)
    })

    const nodeByID = Effect.fn("CodegraphRepo.nodeByID")(function* (id: string) {
      return yield* getNode(id)
    })

    const queryNodes = Effect.fn("CodegraphRepo.queryNodes")(function* (input: { function?: string; kind?: string }) {
      const conditions = []
      if (input.function) {
        conditions.push(eq(CodegraphNodesTable.name, input.function))
      }
      if (input.kind) {
        conditions.push(eq(CodegraphNodesTable.kind, input.kind))
      }
      if (conditions.length === 0) {
        return []
      }
      const whereClause = conditions.length === 1 ? conditions[0] : or(...conditions)
      const rows = yield* db
        .select()
        .from(CodegraphNodesTable)
        .where(whereClause)
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

    const clearAll = Effect.fn("CodegraphRepo.clearAll")(function* () {
      yield* db.delete(CodegraphFilesTable).run().pipe(Effect.orDie)
      yield* db.delete(CodegraphNodesTable).run().pipe(Effect.orDie)
      yield* db.delete(CodegraphEdgesTable).run().pipe(Effect.orDie)
      yield* db.delete(CodegraphEmbeddingsTable).run().pipe(Effect.orDie)
      yield* db.delete(CodegraphMetaTable).run().pipe(Effect.orDie)
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
      putEdges,
      getEdge,
      listAllEdges,
      listEdgesByNode,
      edgesFrom,
      edgesTo,
      putEmbedding,
      getEmbedding,
      resetEmbeddingsTable,
      searchByVector,
      deleteFile,
      clearAll,
      getMeta,
      setMeta,
      bumpVersion,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

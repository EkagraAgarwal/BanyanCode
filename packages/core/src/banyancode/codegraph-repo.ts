export * as CodegraphRepo from "./codegraph-repo"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { CodegraphEdgesTable, CodegraphEmbeddingsTable, CodegraphFilesTable, CodegraphNodesTable } from "./codegraph.sql"
import type { CodegraphEdge, CodegraphFile, CodegraphNode } from "./types"

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
  readonly putEdge: (edge: CodegraphEdge) => Effect.Effect<void, never, never>
  readonly getEdge: (id: string) => Effect.Effect<CodegraphEdge | undefined, never, never>
  readonly listEdgesByNode: (nodeID: string) => Effect.Effect<CodegraphEdge[], never, never>
  readonly edgesFrom: (nodeID: string) => Effect.Effect<CodegraphEdge[], never, never>
  readonly edgesTo: (nodeID: string) => Effect.Effect<CodegraphEdge[], never, never>
  readonly putEmbedding: (nodeID: string, embedding: Uint8Array, model: string, dim: number) => Effect.Effect<void, never, never>
  readonly getEmbedding: (nodeID: string) => Effect.Effect<{ embedding: Uint8Array; model: string; dim: number } | undefined, never, never>
  readonly deleteFile: (id: string) => Effect.Effect<void, never, never>
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
      putEdge,
      getEdge,
      listEdgesByNode,
      edgesFrom,
      edgesTo,
      putEmbedding,
      getEmbedding,
      deleteFile,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

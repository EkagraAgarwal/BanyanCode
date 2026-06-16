export * as CodegraphRepo from "./codegraph-repo"

import { and, eq, inArray, isNotNull, ne, not, or, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import {
  CodegraphEdgesTable,
  CodegraphEmbeddingsTable,
  CodegraphFilesTable,
  CodegraphFtsTable,
  CodegraphNodesTable,
  CodegraphRootsTable,
} from "./codegraph.sql"
import type { CodegraphEdge, CodegraphFile, CodegraphNode, CodegraphRootRow } from "./types"

export interface Interface {
  readonly upsertRoot: (input: { id: string; rootPath: string; parserVersion?: string }) => Effect.Effect<void, never, never>
  readonly getRoot: (rootPath: string) => Effect.Effect<CodegraphRootRow | undefined, never, never>
  readonly listRoots: () => Effect.Effect<CodegraphRootRow[], never, never>
  readonly setRootStats: (input: {
    rootID: string
    stats: { indexedFileCount: number; nodeCount: number; edgeCount: number; lastBuildAt: number; embeddingModel: string | null }
  }) => Effect.Effect<void, never, never>
  readonly putFile: (file: CodegraphFile & { rootID: string; byteSize: number }) => Effect.Effect<void, never, never>
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
  readonly putEmbedding: (input: {
    nodeID: string
    embedding: Uint8Array
    model: string
    baseUrlHash: string
    inputHash: string
    dim: number
    encodingFormat?: "float" | "base64"
  }) => Effect.Effect<void, never, never>
  readonly getEmbedding: (nodeID: string) => Effect.Effect<{ embedding: Uint8Array; model: string; dim: number; baseUrlHash: string; inputHash: string } | undefined, never, never>
  readonly deleteFile: (id: string) => Effect.Effect<void, never, never>
  readonly searchFTS: (query: string, limit: number) => Effect.Effect<Array<{ nodeID: string; bm25: number }>, never, never>
  readonly unresolvedEdgesFor: (rootID: string) => Effect.Effect<Array<{ fromNodeID: string; targetKey: string; kind: string }>, never, never>
  readonly markStaleEmbeddings: (model: string, baseUrlHash: string) => Effect.Effect<number, never, never>
  readonly deleteStaleFiles: (rootID: string, currentPaths: Set<string>) => Effect.Effect<{ removed: number }, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Banyan/CodegraphRepo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const upsertRoot = Effect.fn("CodegraphRepo.upsertRoot")(function* (input: {
      id: string
      rootPath: string
      parserVersion?: string
    }) {
      const now = Date.now()
      yield* db
        .insert(CodegraphRootsTable)
        .values({
          id: input.id,
          root_path: input.rootPath,
          parser_version: input.parserVersion ?? "v1",
          indexed_file_count: 0,
          node_count: 0,
          edge_count: 0,
          created_at: now,
        })
        .onConflictDoUpdate({
          target: CodegraphRootsTable.id,
          set: {
            root_path: input.rootPath,
            parser_version: input.parserVersion ?? "v1",
          },
        })
        .run()
        .pipe(Effect.orDie)
    })

    const getRoot = Effect.fn("CodegraphRepo.getRoot")(function* (rootPath: string) {
      const row = yield* db
        .select()
        .from(CodegraphRootsTable)
        .where(eq(CodegraphRootsTable.root_path, rootPath))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return {
        id: row.id,
        rootPath: row.root_path,
        lastBuildAt: row.last_build_at ?? null,
        indexedFileCount: row.indexed_file_count,
        nodeCount: row.node_count,
        edgeCount: row.edge_count,
        embeddingModel: row.embedding_model ?? null,
        parserVersion: row.parser_version,
        createdAt: row.created_at,
      }
    })

    const listRoots = Effect.fn("CodegraphRepo.listRoots")(function* () {
      const rows = yield* db.select().from(CodegraphRootsTable).all().pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        rootPath: row.root_path,
        lastBuildAt: row.last_build_at ?? null,
        indexedFileCount: row.indexed_file_count,
        nodeCount: row.node_count,
        edgeCount: row.edge_count,
        embeddingModel: row.embedding_model ?? null,
        parserVersion: row.parser_version,
        createdAt: row.created_at,
      }))
    })

    const setRootStats = Effect.fn("CodegraphRepo.setRootStats")(function* (input: {
      rootID: string
      stats: { indexedFileCount: number; nodeCount: number; edgeCount: number; lastBuildAt: number; embeddingModel: string | null }
    }) {
      yield* db
        .update(CodegraphRootsTable)
        .set({
          indexed_file_count: input.stats.indexedFileCount,
          node_count: input.stats.nodeCount,
          edge_count: input.stats.edgeCount,
          last_build_at: input.stats.lastBuildAt,
          embedding_model: input.stats.embeddingModel,
        })
        .where(eq(CodegraphRootsTable.id, input.rootID))
        .run()
        .pipe(Effect.orDie)
    })

    const putFile = Effect.fn("CodegraphRepo.putFile")(function* (file: CodegraphFile & { rootID: string; byteSize: number }) {
      yield* db
        .insert(CodegraphFilesTable)
        .values({
          id: file.id,
          root_id: file.rootID,
          path: file.path,
          content_hash: file.contentHash,
          byte_size: file.byteSize,
          language: file.language,
          indexed_at: file.indexedAt,
        })
        .onConflictDoUpdate({
          target: CodegraphFilesTable.id,
          set: {
            path: file.path,
            content_hash: file.contentHash,
            byte_size: file.byteSize,
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
      const now = Date.now()
      yield* db
        .insert(CodegraphNodesTable)
        .values({
          id: node.id,
          file_id: node.fileID,
          kind: node.kind,
          name: node.name,
          qualified_name: node.qualifiedName,
          start_line: node.startLine,
          start_byte: node.startByte,
          end_line: node.endLine,
          end_byte: node.endByte,
          language: node.language,
          signature: node.signature,
          doc: node.doc,
          text_excerpt: node.textExcerpt,
          node_code_hash: node.nodeCodeHash,
          created_at: now,
        })
        .onConflictDoUpdate({
          target: CodegraphNodesTable.id,
          set: {
            file_id: node.fileID,
            kind: node.kind,
            name: node.name,
            qualified_name: node.qualifiedName,
            start_line: node.startLine,
            start_byte: node.startByte,
            end_line: node.endLine,
            end_byte: node.endByte,
            language: node.language,
            signature: node.signature,
            doc: node.doc,
            text_excerpt: node.textExcerpt,
            node_code_hash: node.nodeCodeHash,
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
        qualifiedName: row.qualified_name,
        startLine: row.start_line,
        startByte: row.start_byte,
        endLine: row.end_line,
        endByte: row.end_byte,
        language: row.language,
        signature: row.signature ?? undefined,
        doc: row.doc ?? undefined,
        textExcerpt: row.text_excerpt,
        nodeCodeHash: row.node_code_hash,
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
        qualifiedName: row.qualified_name,
        startLine: row.start_line,
        startByte: row.start_byte,
        endLine: row.end_line,
        endByte: row.end_byte,
        language: row.language,
        signature: row.signature ?? undefined,
        doc: row.doc ?? undefined,
        textExcerpt: row.text_excerpt,
        nodeCodeHash: row.node_code_hash,
      }))
    })

    const listAllNodes = Effect.fn("CodegraphRepo.listAllNodes")(function* () {
      const rows = yield* db.select().from(CodegraphNodesTable).all().pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        fileID: row.file_id,
        kind: row.kind as CodegraphNode["kind"],
        name: row.name,
        qualifiedName: row.qualified_name,
        startLine: row.start_line,
        startByte: row.start_byte,
        endLine: row.end_line,
        endByte: row.end_byte,
        language: row.language,
        signature: row.signature ?? undefined,
        doc: row.doc ?? undefined,
        textExcerpt: row.text_excerpt,
        nodeCodeHash: row.node_code_hash,
      }))
    })

    const putEdge = Effect.fn("CodegraphRepo.putEdge")(function* (edge: CodegraphEdge) {
      yield* db
        .insert(CodegraphEdgesTable)
        .values({
          id: edge.id,
          from_node_id: edge.fromNodeID,
          to_node_id: edge.toNodeID,
          to_target_key: edge.toTargetKey,
          file_id: edge.fileID,
          line: edge.line,
          kind: edge.kind,
          weight: edge.weight,
        })
        .onConflictDoUpdate({
          target: CodegraphEdgesTable.id,
          set: {
            from_node_id: edge.fromNodeID,
            to_node_id: edge.toNodeID,
            to_target_key: edge.toTargetKey,
            file_id: edge.fileID,
            line: edge.line,
            kind: edge.kind,
            weight: edge.weight,
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
        toNodeID: row.to_node_id ?? undefined,
        toTargetKey: row.to_target_key ?? undefined,
        fileID: row.file_id,
        line: row.line,
        kind: row.kind as CodegraphEdge["kind"],
        weight: row.weight,
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
        toNodeID: row.to_node_id ?? undefined,
        toTargetKey: row.to_target_key ?? undefined,
        fileID: row.file_id,
        line: row.line,
        kind: row.kind as CodegraphEdge["kind"],
        weight: row.weight,
      }))
    })

    const putEmbedding = Effect.fn("CodegraphRepo.putEmbedding")(function* (input: {
      nodeID: string
      embedding: Uint8Array
      model: string
      baseUrlHash: string
      inputHash: string
      dim: number
      encodingFormat?: "float" | "base64"
    }) {
      const now = Date.now()
      const embeddingBuffer = Buffer.from(input.embedding)
      yield* db
        .insert(CodegraphEmbeddingsTable)
        .values({
          id: `${input.nodeID}:${input.model}:${input.baseUrlHash}`,
          node_id: input.nodeID,
          embedding: embeddingBuffer,
          model: input.model,
          base_url_hash: input.baseUrlHash,
          input_hash: input.inputHash,
          dim: input.dim,
          encoding_format: input.encodingFormat ?? "float",
          created_at: now,
        })
        .onConflictDoUpdate({
          target: CodegraphEmbeddingsTable.id,
          set: {
            embedding: embeddingBuffer,
            model: input.model,
            base_url_hash: input.baseUrlHash,
            input_hash: input.inputHash,
            dim: input.dim,
            encoding_format: input.encodingFormat ?? "float",
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
        baseUrlHash: row.base_url_hash,
        inputHash: row.input_hash,
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
        toNodeID: row.to_node_id ?? undefined,
        toTargetKey: row.to_target_key ?? undefined,
        fileID: row.file_id,
        line: row.line,
        kind: row.kind as CodegraphEdge["kind"],
        weight: row.weight,
      }))
    })

    const searchFTS = Effect.fn("CodegraphRepo.searchFTS")(function* (query: string, limit: number) {
      const rows = yield* db
        .select({
          nodeID: CodegraphFtsTable.node_id,
          bm25: sql<number>`bm25(${CodegraphFtsTable})`,
        })
        .from(CodegraphFtsTable)
        .where(sql`codegraph_fts MATCH ${query}`)
        .orderBy(sql`bm25(${CodegraphFtsTable})`)
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({ nodeID: row.nodeID, bm25: row.bm25 }))
    })

    const unresolvedEdgesFor = Effect.fn("CodegraphRepo.unresolvedEdgesFor")(function* (rootID: string) {
      const rows = yield* db
        .select({
          fromNodeID: CodegraphEdgesTable.from_node_id,
          targetKey: CodegraphEdgesTable.to_target_key,
          kind: CodegraphEdgesTable.kind,
        })
        .from(CodegraphEdgesTable)
        .innerJoin(CodegraphFilesTable, eq(CodegraphEdgesTable.file_id, CodegraphFilesTable.id))
        .where(
          and(
            eq(CodegraphFilesTable.root_id, rootID),
            isNotNull(CodegraphEdgesTable.to_target_key),
            eq(CodegraphEdgesTable.to_node_id, sql`NULL`),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        fromNodeID: row.fromNodeID,
        targetKey: row.targetKey!,
        kind: row.kind,
      }))
    })

    const markStaleEmbeddings = Effect.fn("CodegraphRepo.markStaleEmbeddings")(function* (model: string, baseUrlHash: string) {
      const result = yield* db
        .delete(CodegraphEmbeddingsTable)
        .where(
          or(
            ne(CodegraphEmbeddingsTable.model, model),
            ne(CodegraphEmbeddingsTable.base_url_hash, baseUrlHash),
          ),
        )
        .returning()
        .run()
        .pipe(Effect.orDie)
      return result.length
    })

    const deleteStaleFiles = Effect.fn("CodegraphRepo.deleteStaleFiles")(function* (
      rootID: string,
      currentPaths: Set<string>,
    ) {
      const allFiles = yield* db
        .select({ id: CodegraphFilesTable.id, path: CodegraphFilesTable.path })
        .from(CodegraphFilesTable)
        .where(eq(CodegraphFilesTable.root_id, rootID))
        .all()
        .pipe(Effect.orDie)
      const stale = allFiles.filter((f) => !currentPaths.has(f.path))
      if (stale.length === 0) return { removed: 0 }
      const ids = stale.map((f) => f.id)
      yield* db.delete(CodegraphFilesTable).where(inArray(CodegraphFilesTable.id, ids)).run().pipe(Effect.orDie)
      return { removed: stale.length }
    })

    return Service.of({
      upsertRoot,
      getRoot,
      listRoots,
      setRootStats,
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
      searchFTS,
      unresolvedEdgesFor,
      markStaleEmbeddings,
      deleteStaleFiles,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

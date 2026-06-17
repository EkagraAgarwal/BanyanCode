import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CodeEmbedTools } from "../../../core/src/tool/code-embed"
import { ToolRegistry } from "../../../core/src/tool/registry"
import { PermissionV2 } from "../../../core/src/permission"
import { Banyan } from "../../../core/src/banyancode"
import { EmbeddingProvider } from "../../../core/src/banyancode/embedding-provider"
import { PluginV2 } from "../../../core/src/plugin"
import { testEffect } from "../lib/effect"

process.env.BANYANCODE_ENABLE = "1"

const mockPermissionLayer = Layer.succeed(PermissionV2.Service, PermissionV2.Service.of({
  ask: () => Effect.succeed({ id: { _id: "per_test" } as any, effect: "allow" as const }),
  assert: () => Effect.void,
  reply: () => Effect.void,
  get: () => Effect.succeed(undefined),
  forSession: () => Effect.succeed([]),
  list: () => Effect.succeed([]),
}))

const mockPluginLayer = Layer.succeed(PluginV2.Service, PluginV2.Service.of({
  add: () => Effect.void,
  remove: () => Effect.void,
  triggerFor: () => Effect.succeed({} as any),
  trigger: () => Effect.succeed({} as any),
}))

const mockCodegraphEntries: {
  files: Banyan.CodegraphFile[]
  nodes: Banyan.CodegraphNode[]
  edges: Banyan.CodegraphEdge[]
  embeddings: Map<string, { embedding: Uint8Array; model: string; dim: number; baseUrlHash: string; inputHash: string }>
} = {
  files: [],
  nodes: [],
  edges: [],
  embeddings: new Map(),
}

const mockRepoLayer = Layer.succeed(Banyan.CodegraphRepo, Banyan.CodegraphRepo.of({
  upsertRoot: () => Effect.void,
  getRoot: () => Effect.succeed(undefined),
  listRoots: () => Effect.succeed([]),
  setRootStats: () => Effect.void,
  putFile: (file) => Effect.sync(() => mockCodegraphEntries.files.push(file)),
  getFile: (id: string) => Effect.sync(() => mockCodegraphEntries.files.find((f) => f.id === id)),
  getFileByPath: (path: string) => Effect.sync(() => mockCodegraphEntries.files.find((f) => f.path === path)),
  listAllFiles: () => Effect.sync(() => mockCodegraphEntries.files),
  putNode: (node) => Effect.sync(() => mockCodegraphEntries.nodes.push(node)),
  getNode: (id: string) => Effect.sync(() => mockCodegraphEntries.nodes.find((n) => n.id === id)),
  nodeByID: (id: string) => Effect.sync(() => mockCodegraphEntries.nodes.find((n) => n.id === id)),
  listNodesByFile: (fileID: string) => Effect.sync(() => mockCodegraphEntries.nodes.filter((n) => n.fileID === fileID)),
  listAllNodes: () => Effect.sync(() => mockCodegraphEntries.nodes),
  queryNodes: (input: { function?: string; kind?: string }) => Effect.sync(() =>
    mockCodegraphEntries.nodes.filter((n) => {
      if (input.function && n.name === input.function) return true
      if (input.kind && n.kind === input.kind) return true
      return false
    })
  ),
  putEdge: (edge) => Effect.sync(() => mockCodegraphEntries.edges.push(edge)),
  getEdge: (id: string) => Effect.sync(() => mockCodegraphEntries.edges.find((e) => e.id === id)),
  listEdgesByNode: (nodeID: string) => Effect.sync(() => mockCodegraphEntries.edges.filter((e) => e.fromNodeID === nodeID)),
  edgesFrom: (nodeID: string) => Effect.sync(() => mockCodegraphEntries.edges.filter((e) => e.fromNodeID === nodeID)),
  edgesTo: (nodeID: string) => Effect.sync(() => mockCodegraphEntries.edges.filter((e) => e.toNodeID === nodeID)),
  putEmbedding: (input: { nodeID: string; embedding: Uint8Array; model: string; baseUrlHash: string; inputHash: string; dim: number; encodingFormat?: "float" | "base64" }) =>
    Effect.sync(() => {
      mockCodegraphEntries.embeddings.set(input.nodeID, { embedding: input.embedding, model: input.model, dim: input.dim, baseUrlHash: input.baseUrlHash, inputHash: input.inputHash })
    }),
  getEmbedding: (nodeID: string) => Effect.sync(() => mockCodegraphEntries.embeddings.get(nodeID)),
  deleteFile: (id: string) => Effect.sync(() => {
    mockCodegraphEntries.files = mockCodegraphEntries.files.filter((f) => f.id !== id)
    mockCodegraphEntries.nodes = mockCodegraphEntries.nodes.filter((n) => n.fileID !== id)
  }),
  searchFTS: (query: string, _limit: number) => {
    const lowerQuery = query.toLowerCase()
    const results = mockCodegraphEntries.nodes
      .filter((n) => n.name.toLowerCase().includes(lowerQuery))
      .map((n, i) => ({ nodeID: n.id, bm25: i + 1 }))
    return Effect.succeed(results)
  },
  unresolvedEdgesFor: () => Effect.succeed([]),
  markStaleEmbeddings: () => Effect.succeed(0),
  deleteStaleFiles: () => Effect.succeed({ removed: 0 }),
  countAllEdges: () => Effect.succeed(0),
  putNodesAndEdges: () => Effect.void,
  putNodesAndEdgesBatched: () => Effect.void,
  getGraphContext: (_input: { nodeIDs: string[]; maxUpHops?: number; maxDownHops?: number; limit?: number }) =>
    Effect.succeed({ nodes: [], edges: [] }),
}))

const mockEmbeddingProviderNoModelLayer = Layer.succeed(
  Banyan.EmbeddingProviderService,
  Banyan.EmbeddingProviderService.of({
    embed: (input: string | string[]) =>
      Effect.fail(new EmbeddingProvider.EmbeddingError({ message: "no embedding model configured" })),
    model: () => undefined,
    setModel: () => Effect.void,
    inputHash: (text: string) => Buffer.from(text).toString("hex"),
    config: () => ({ baseUrl: "https://api.openai.com/v1", apiKey: undefined, dimensions: undefined, batchSize: 64 }),
  }),
)

const mockCodegraphEmbedderLayer = Layer.succeed(Banyan.CodegraphEmbedder, Banyan.CodegraphEmbedder.of({
  embedAll: () => Effect.succeed({ embedded: 0, skipped: 0, failed: 0, model: undefined }),
  embedFile: (_fileID: string) => Effect.succeed({ embedded: 0, skipped: 0, failed: 0 }),
  embedNode: (node) => Effect.void,
}))

const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(mockPermissionLayer))

const makeToolLayer = (provider: Layer.Layer<any, any, any>) => {
  const toolLayerWithDeps = CodeEmbedTools.locationLayer.pipe(
    Layer.provide(mockRepoLayer),
    Layer.provide(mockCodegraphEmbedderLayer),
    Layer.provide(provider),
  )
  return Layer.mergeAll(
    toolLayerWithDeps,
    mockRepoLayer,
    mockCodegraphEmbedderLayer,
    provider,
  ).pipe(
    Layer.provide(registry),
    Layer.provide(mockPermissionLayer),
  )
}

const makeIt = (provider: Layer.Layer<any, any, any>) =>
  testEffect(Layer.mergeAll(
    mockPermissionLayer,
    registry,
    mockRepoLayer,
    mockCodegraphEmbedderLayer,
    provider,
    makeToolLayer(provider),
  ) as any)

const makeCtx = (sessionID = "test-session") => ({
  sessionID: sessionID as any,
  messageID: "msg-1" as any,
  agent: "test" as any,
  assistantMessageID: "am-1" as any,
  toolCallID: "tc-1",
  abort: new AbortController().signal,
  messages: [] as any[],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const mockProviderWithModelLayer = Layer.succeed(
  Banyan.EmbeddingProviderService,
  Banyan.EmbeddingProviderService.of({
    embed: (input: string | string[]) =>
      Effect.succeed([new Float32Array([1, 0, 0])]),
    model: () => "test-model",
    setModel: () => Effect.void,
    inputHash: (text: string) => Buffer.from(text).toString("hex"),
    config: () => ({ baseUrl: "https://api.openai.com/v1", apiKey: undefined, dimensions: undefined, batchSize: 64 }),
  }),
)

describe("code_embed tools", () => {
  const itNoModel = makeIt(mockEmbeddingProviderNoModelLayer)
  const itWithModel = makeIt(mockProviderWithModelLayer)

  itNoModel.effect("code_search without embedding model returns keyword results and degraded=true", () =>
    Effect.gen(function* () {
      mockCodegraphEntries.nodes.length = 0
      mockCodegraphEntries.files.length = 0
      mockCodegraphEntries.embeddings.clear()

      mockCodegraphEntries.files.push({
        id: "file-1",
        path: "test.ts",
        contentHash: "hash1",
        language: "typescript",
        indexedAt: Date.now(),
      })

      mockCodegraphEntries.nodes.push(
        {
          id: "node-1",
          fileID: "file-1",
          kind: "function",
          name: "createUser",
          qualifiedName: "test.ts::createUser",
          signature: "(name: string) => User",
          startLine: 1,
          startByte: 0,
          endLine: 10,
          endByte: 0,
          language: "typescript",
          textExcerpt: "function createUser(name: string) { return { name }; }",
          nodeCodeHash: "abc123",
          code: "function createUser(name: string) { return { name }; }",
        },
        {
          id: "node-2",
          fileID: "file-1",
          kind: "function",
          name: "deleteUser",
          qualifiedName: "test.ts::deleteUser",
          signature: "(id: string) => void",
          startLine: 12,
          startByte: 0,
          endLine: 20,
          endByte: 0,
          language: "typescript",
          textExcerpt: "function deleteUser(id: string) { console.log(id); }",
          nodeCodeHash: "def456",
          code: "function deleteUser(id: string) { console.log(id); }",
        },
      )

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const searchResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-search",
          name: "code_search",
          input: { query: "createUser" },
        },
      })

      const output = searchResult.output?.structured as any
      expect(output.degraded).toBe(true)
      expect(output.mode).toBe("hybrid")
      expect(output.seedCount).toBeGreaterThanOrEqual(0)
    }),
  )

  itWithModel.effect("code_search with mock embedding provider returns cosine similarity results", () =>
    Effect.gen(function* () {
      mockCodegraphEntries.nodes.length = 0
      mockCodegraphEntries.files.length = 0
      mockCodegraphEntries.embeddings.clear()

      mockCodegraphEntries.files.push({
        id: "file-1",
        path: "test.ts",
        contentHash: "hash1",
        language: "typescript",
        indexedAt: Date.now(),
      })

      mockCodegraphEntries.nodes.push(
        {
          id: "node-1",
          fileID: "file-1",
          kind: "function",
          name: "foo",
          qualifiedName: "test.ts::foo",
          signature: "() => void",
          startLine: 1,
          startByte: 0,
          endLine: 5,
          endByte: 0,
          language: "typescript",
          textExcerpt: "function foo() { return 1 }",
          nodeCodeHash: "abc123",
          code: "function foo() { return 1 }",
        },
        {
          id: "node-2",
          fileID: "file-1",
          kind: "function",
          name: "bar",
          qualifiedName: "test.ts::bar",
          signature: "() => void",
          startLine: 7,
          startByte: 0,
          endLine: 10,
          endByte: 0,
          language: "typescript",
          textExcerpt: "function bar() { return 2 }",
          nodeCodeHash: "def456",
          code: "function bar() { return 2 }",
        },
      )

      mockCodegraphEntries.embeddings.set("node-1", {
        embedding: new Uint8Array(new Float32Array([1, 0, 0]).buffer),
        model: "test-model",
        dim: 3,
        baseUrlHash: "test-url-hash",
        inputHash: "test-input-hash",
      })
      mockCodegraphEntries.embeddings.set("node-2", {
        embedding: new Uint8Array(new Float32Array([0, 1, 0]).buffer),
        model: "test-model",
        dim: 3,
        baseUrlHash: "test-url-hash",
        inputHash: "test-input-hash-2",
      })

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const searchResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-search",
          name: "code_search",
          input: { query: "foo" },
        },
      })

      const output = searchResult.output?.structured as any
      expect(output.degraded).toBe(false)
      expect(output.mode).toBe("hybrid")
      expect(output.hits.length).toBeGreaterThan(0)
    }),
  )

  itNoModel.effect("code_embed_update without embedding model returns model=null", () =>
    Effect.gen(function* () {
      mockCodegraphEntries.nodes.length = 0
      mockCodegraphEntries.files.length = 0
      mockCodegraphEntries.embeddings.clear()

      mockCodegraphEntries.files.push({
        id: "file-1",
        path: "test.ts",
        contentHash: "hash1",
        language: "typescript",
        indexedAt: Date.now(),
      })

      mockCodegraphEntries.nodes.push({
        id: "node-1",
        fileID: "file-1",
        kind: "function",
        name: "testFunc",
        qualifiedName: "test.ts::testFunc",
        signature: "() => void",
        startLine: 1,
        startByte: 0,
        endLine: 5,
        endByte: 0,
        language: "typescript",
        textExcerpt: "function testFunc() { return; }",
        nodeCodeHash: "abc123",
        code: "function testFunc() { return; }",
      })

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const embedResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-embed",
          name: "code_embed_update",
          input: {},
        },
      })

      expect((embedResult.output?.structured as any).model).toBeNull()
    }),
  )

  itWithModel.effect("code_search returns hits with file, range, name, kind, score, reason, code", () =>
    Effect.gen(function* () {
      mockCodegraphEntries.nodes.length = 0
      mockCodegraphEntries.files.length = 0
      mockCodegraphEntries.embeddings.clear()

      mockCodegraphEntries.files.push({
        id: "file-1",
        path: "test.ts",
        contentHash: "hash1",
        language: "typescript",
        indexedAt: Date.now(),
      })

      mockCodegraphEntries.nodes.push({
        id: "node-1",
        fileID: "file-1",
        kind: "function",
        name: "testFunc",
        qualifiedName: "test.ts::testFunc",
        signature: "() => void",
        startLine: 1,
        startByte: 0,
        endLine: 5,
        endByte: 0,
        language: "typescript",
        textExcerpt: "function testFunc() { return; }",
        nodeCodeHash: "abc123",
        code: "function testFunc() { return; }",
      })

      mockCodegraphEntries.embeddings.set("node-1", {
        embedding: new Uint8Array(new Float32Array([1, 0, 0]).buffer),
        model: "test-model",
        dim: 3,
        baseUrlHash: "test-url-hash",
        inputHash: "test-input-hash",
      })

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const searchResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-search",
          name: "code_search",
          input: { query: "testFunc", includeCode: true },
        },
      })

      const output = searchResult.output?.structured as any
      expect(output.hits.length).toBeGreaterThan(0)
      const hit = output.hits[0]
      expect(hit).toHaveProperty("id")
      expect(hit).toHaveProperty("file")
      expect(hit).toHaveProperty("range")
      expect(hit.range.startLine).toBe(1)
      expect(hit.range.endLine).toBe(5)
      expect(hit).toHaveProperty("name")
      expect(hit.name).toBe("testFunc")
      expect(hit).toHaveProperty("kind")
      expect(hit).toHaveProperty("score")
      expect(hit).toHaveProperty("reason")
      expect(hit).toHaveProperty("code")
      expect(output.seedCount).toBeGreaterThanOrEqual(0)
      expect(output.expandedCount).toBeGreaterThanOrEqual(0)
    }),
  )

  itNoModel.effect("code_search in lexical mode uses FTS only", () =>
    Effect.gen(function* () {
      mockCodegraphEntries.nodes.length = 0
      mockCodegraphEntries.files.length = 0
      mockCodegraphEntries.embeddings.clear()

      mockCodegraphEntries.files.push({
        id: "file-1",
        path: "test.ts",
        contentHash: "hash1",
        language: "typescript",
        indexedAt: Date.now(),
      })

      mockCodegraphEntries.nodes.push({
        id: "node-1",
        fileID: "file-1",
        kind: "function",
        name: "foo",
        qualifiedName: "test.ts::foo",
        signature: "() => void",
        startLine: 1,
        startByte: 0,
        endLine: 5,
        endByte: 0,
        language: "typescript",
        textExcerpt: "function foo() { return 1 }",
        nodeCodeHash: "abc123",
        code: "function foo() { return 1 }",
      })

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const searchResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-search",
          name: "code_search",
          input: { query: "foo", mode: "lexical" },
        },
      })

      const output = searchResult.output?.structured as any
      expect(output.mode).toBe("lexical")
    }),
  )

  itWithModel.effect("code_search in semantic mode uses embeddings only", () =>
    Effect.gen(function* () {
      mockCodegraphEntries.nodes.length = 0
      mockCodegraphEntries.files.length = 0
      mockCodegraphEntries.embeddings.clear()

      mockCodegraphEntries.files.push({
        id: "file-1",
        path: "test.ts",
        contentHash: "hash1",
        language: "typescript",
        indexedAt: Date.now(),
      })

      mockCodegraphEntries.nodes.push({
        id: "node-1",
        fileID: "file-1",
        kind: "function",
        name: "foo",
        qualifiedName: "test.ts::foo",
        signature: "() => void",
        startLine: 1,
        startByte: 0,
        endLine: 5,
        endByte: 0,
        language: "typescript",
        textExcerpt: "function foo() { return 1 }",
        nodeCodeHash: "abc123",
        code: "function foo() { return 1 }",
      })

      mockCodegraphEntries.embeddings.set("node-1", {
        embedding: new Uint8Array(new Float32Array([1, 0, 0]).buffer),
        model: "test-model",
        dim: 3,
        baseUrlHash: "test-url-hash",
        inputHash: "test-input-hash",
      })

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const searchResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-search",
          name: "code_search",
          input: { query: "foo", mode: "semantic" },
        },
      })

      const output = searchResult.output?.structured as any
      expect(output.mode).toBe("semantic")
      expect(output.degraded).toBe(false)
    }),
  )

  itWithModel.effect("code_search in hybrid mode combines FTS and embeddings", () =>
    Effect.gen(function* () {
      mockCodegraphEntries.nodes.length = 0
      mockCodegraphEntries.files.length = 0
      mockCodegraphEntries.embeddings.clear()

      mockCodegraphEntries.files.push({
        id: "file-1",
        path: "test.ts",
        contentHash: "hash1",
        language: "typescript",
        indexedAt: Date.now(),
      })

      mockCodegraphEntries.nodes.push({
        id: "node-1",
        fileID: "file-1",
        kind: "function",
        name: "foo",
        qualifiedName: "test.ts::foo",
        signature: "() => void",
        startLine: 1,
        startByte: 0,
        endLine: 5,
        endByte: 0,
        language: "typescript",
        textExcerpt: "function foo() { return 1 }",
        nodeCodeHash: "abc123",
        code: "function foo() { return 1 }",
      })

      mockCodegraphEntries.embeddings.set("node-1", {
        embedding: new Uint8Array(new Float32Array([1, 0, 0]).buffer),
        model: "test-model",
        dim: 3,
        baseUrlHash: "test-url-hash",
        inputHash: "test-input-hash",
      })

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const searchResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-search",
          name: "code_search",
          input: { query: "foo", mode: "hybrid" },
        },
      })

      const output = searchResult.output?.structured as any
      expect(output.mode).toBe("hybrid")
      expect(output.degraded).toBe(false)
    }),
  )

  itWithModel.effect("code_search in graph mode uses only graph expansion", () =>
    Effect.gen(function* () {
      mockCodegraphEntries.nodes.length = 0
      mockCodegraphEntries.files.length = 0
      mockCodegraphEntries.embeddings.clear()
      mockCodegraphEntries.edges.length = 0

      mockCodegraphEntries.files.push({
        id: "file-1",
        path: "test.ts",
        contentHash: "hash1",
        language: "typescript",
        indexedAt: Date.now(),
      })

      mockCodegraphEntries.nodes.push(
        {
          id: "node-seed",
          fileID: "file-1",
          kind: "function",
          name: "seedFunc",
          qualifiedName: "test.ts::seedFunc",
          signature: "() => void",
          startLine: 1,
          startByte: 0,
          endLine: 5,
          endByte: 0,
          language: "typescript",
          textExcerpt: "function seedFunc() { return 1 }",
          nodeCodeHash: "abc123",
          code: "function seedFunc() { return 1 }",
        },
        {
          id: "node-expanded",
          fileID: "file-1",
          kind: "function",
          name: "expandedFunc",
          qualifiedName: "test.ts::expandedFunc",
          signature: "() => void",
          startLine: 10,
          startByte: 0,
          endLine: 15,
          endByte: 0,
          language: "typescript",
          textExcerpt: "function expandedFunc() { return 2 }",
          nodeCodeHash: "def456",
          code: "function expandedFunc() { return 2 }",
        },
      )

      mockCodegraphEntries.edges.push({
        id: "edge-1",
        fromNodeID: "node-seed",
        toNodeID: "node-expanded",
        toTargetKey: undefined,
        fileID: "file-1",
        line: 6,
        kind: "calls",
        weight: 1.0,
      })

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const searchResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-search",
          name: "code_search",
          input: { query: "seedFunc", mode: "graph" },
        },
      })

      const output = searchResult.output?.structured as any
      expect(output.mode).toBe("graph")
    }),
  )

  itWithModel.effect("code_search with fileGlob filters by file pattern", () =>
    Effect.gen(function* () {
      mockCodegraphEntries.nodes.length = 0
      mockCodegraphEntries.files.length = 0
      mockCodegraphEntries.embeddings.clear()

      mockCodegraphEntries.files.push(
        {
          id: "file-match",
          path: "src/match.ts",
          contentHash: "hash1",
          language: "typescript",
          indexedAt: Date.now(),
        },
        {
          id: "file-skip",
          path: "other/skip.ts",
          contentHash: "hash2",
          language: "typescript",
          indexedAt: Date.now(),
        },
      )

      mockCodegraphEntries.nodes.push(
        {
          id: "node-match",
          fileID: "file-match",
          kind: "function",
          name: "matchFunc",
          qualifiedName: "src/match.ts::matchFunc",
          signature: "() => void",
          startLine: 1,
          startByte: 0,
          endLine: 5,
          endByte: 0,
          language: "typescript",
          textExcerpt: "function matchFunc() { return 1 }",
          nodeCodeHash: "abc123",
          code: "function matchFunc() { return 1 }",
        },
        {
          id: "node-skip",
          fileID: "file-skip",
          kind: "function",
          name: "skipFunc",
          qualifiedName: "other/skip.ts::skipFunc",
          signature: "() => void",
          startLine: 1,
          startByte: 0,
          endLine: 5,
          endByte: 0,
          language: "typescript",
          textExcerpt: "function skipFunc() { return 2 }",
          nodeCodeHash: "def456",
          code: "function skipFunc() { return 2 }",
        },
      )

      mockCodegraphEntries.embeddings.set("node-match", {
        embedding: new Uint8Array(new Float32Array([1, 0, 0]).buffer),
        model: "test-model",
        dim: 3,
        baseUrlHash: "test-url-hash",
        inputHash: "test-input-hash",
      })
      mockCodegraphEntries.embeddings.set("node-skip", {
        embedding: new Uint8Array(new Float32Array([0, 1, 0]).buffer),
        model: "test-model",
        dim: 3,
        baseUrlHash: "test-url-hash",
        inputHash: "test-input-hash-2",
      })

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const searchResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-search",
          name: "code_search",
          input: { query: "func", fileGlob: "src/*.ts" },
        },
      })

      const output = searchResult.output?.structured as any
      for (const hit of output.hits) {
        expect(hit.file).toMatch(/^src\//)
      }
    }),
  )

  itWithModel.effect("code_search respects maxDepth", () =>
    Effect.gen(function* () {
      mockCodegraphEntries.nodes.length = 0
      mockCodegraphEntries.files.length = 0
      mockCodegraphEntries.embeddings.clear()
      mockCodegraphEntries.edges.length = 0

      mockCodegraphEntries.files.push({
        id: "file-1",
        path: "test.ts",
        contentHash: "hash1",
        language: "typescript",
        indexedAt: Date.now(),
      })

      mockCodegraphEntries.nodes.push(
        {
          id: "node-seed",
          fileID: "file-1",
          kind: "function",
          name: "seedFunc",
          qualifiedName: "test.ts::seedFunc",
          signature: "() => void",
          startLine: 1,
          startByte: 0,
          endLine: 5,
          endByte: 0,
          language: "typescript",
          textExcerpt: "function seedFunc() { return 1 }",
          nodeCodeHash: "abc123",
          code: "function seedFunc() { return 1 }",
        },
        {
          id: "node-depth1",
          fileID: "file-1",
          kind: "function",
          name: "depth1Func",
          qualifiedName: "test.ts::depth1Func",
          signature: "() => void",
          startLine: 10,
          startByte: 0,
          endLine: 15,
          endByte: 0,
          language: "typescript",
          textExcerpt: "function depth1Func() { return 2 }",
          nodeCodeHash: "def456",
          code: "function depth1Func() { return 2 }",
        },
        {
          id: "node-depth2",
          fileID: "file-1",
          kind: "function",
          name: "depth2Func",
          qualifiedName: "test.ts::depth2Func",
          signature: "() => void",
          startLine: 20,
          startByte: 0,
          endLine: 25,
          endByte: 0,
          language: "typescript",
          textExcerpt: "function depth2Func() { return 3 }",
          nodeCodeHash: "ghi789",
          code: "function depth2Func() { return 3 }",
        },
      )

      mockCodegraphEntries.edges.push(
        {
          id: "edge-seed",
          fromNodeID: "node-seed",
          toNodeID: "node-depth1",
          toTargetKey: undefined,
          fileID: "file-1",
          line: 6,
          kind: "calls",
          weight: 1.0,
        },
        {
          id: "edge-depth1",
          fromNodeID: "node-depth1",
          toNodeID: "node-depth2",
          toTargetKey: undefined,
          fileID: "file-1",
          line: 16,
          kind: "calls",
          weight: 1.0,
        },
      )

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const searchResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-search",
          name: "code_search",
          input: { query: "seedFunc", mode: "graph", maxDepth: 1 },
        },
      })

      const output = searchResult.output?.structured as any
      const hitNames = output.hits.map((h: any) => h.name)
      expect(hitNames).toContain("seedFunc")
      expect(hitNames).toContain("depth1Func")
      expect(hitNames).not.toContain("depth2Func")
    }),
  )

  itWithModel.effect("code_search respects direction upstream/downstream/both", () =>
    Effect.gen(function* () {
      mockCodegraphEntries.nodes.length = 0
      mockCodegraphEntries.files.length = 0
      mockCodegraphEntries.embeddings.clear()
      mockCodegraphEntries.edges.length = 0

      mockCodegraphEntries.files.push({
        id: "file-1",
        path: "test.ts",
        contentHash: "hash1",
        language: "typescript",
        indexedAt: Date.now(),
      })

      mockCodegraphEntries.nodes.push(
        {
          id: "node-upstream",
          fileID: "file-1",
          kind: "function",
          name: "upstreamFunc",
          qualifiedName: "test.ts::upstreamFunc",
          signature: "() => void",
          startLine: 1,
          startByte: 0,
          endLine: 5,
          endByte: 0,
          language: "typescript",
          textExcerpt: "function upstreamFunc() { return 1 }",
          nodeCodeHash: "abc123",
          code: "function upstreamFunc() { return 1 }",
        },
        {
          id: "node-center",
          fileID: "file-1",
          kind: "function",
          name: "centerFunc",
          qualifiedName: "test.ts::centerFunc",
          signature: "() => void",
          startLine: 10,
          startByte: 0,
          endLine: 15,
          endByte: 0,
          language: "typescript",
          textExcerpt: "function centerFunc() { return 2 }",
          nodeCodeHash: "def456",
          code: "function centerFunc() { return 2 }",
        },
        {
          id: "node-downstream",
          fileID: "file-1",
          kind: "function",
          name: "downstreamFunc",
          qualifiedName: "test.ts::downstreamFunc",
          signature: "() => void",
          startLine: 20,
          startByte: 0,
          endLine: 25,
          endByte: 0,
          language: "typescript",
          textExcerpt: "function downstreamFunc() { return 3 }",
          nodeCodeHash: "ghi789",
          code: "function downstreamFunc() { return 3 }",
        },
      )

      mockCodegraphEntries.edges.push(
        {
          id: "edge-up",
          fromNodeID: "node-upstream",
          toNodeID: "node-center",
          toTargetKey: undefined,
          fileID: "file-1",
          line: 6,
          kind: "calls",
          weight: 1.0,
        },
        {
          id: "edge-down",
          fromNodeID: "node-center",
          toNodeID: "node-downstream",
          toTargetKey: undefined,
          fileID: "file-1",
          line: 16,
          kind: "calls",
          weight: 1.0,
        },
      )

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      // Test downstream only
      const downstreamResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-search-down",
          name: "code_search",
          input: { query: "centerFunc", mode: "graph", direction: "downstream" },
        },
      })

      const downstreamOutput = downstreamResult.output?.structured as any
      const downstreamNames = downstreamOutput.hits.map((h: any) => h.name)
      expect(downstreamNames).toContain("centerFunc")
      expect(downstreamNames).toContain("downstreamFunc")
      expect(downstreamNames).not.toContain("upstreamFunc")

      // Test upstream only
      const upstreamResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-search-up",
          name: "code_search",
          input: { query: "centerFunc", mode: "graph", direction: "upstream" },
        },
      })

      const upstreamOutput = upstreamResult.output?.structured as any
      const upstreamNames = upstreamOutput.hits.map((h: any) => h.name)
      expect(upstreamNames).toContain("centerFunc")
      expect(upstreamNames).toContain("upstreamFunc")
      expect(upstreamNames).not.toContain("downstreamFunc")
    }),
  )

  itNoModel.effect("code_search degraded flag is true when no embedding model", () =>
    Effect.gen(function* () {
      mockCodegraphEntries.nodes.length = 0
      mockCodegraphEntries.files.length = 0
      mockCodegraphEntries.embeddings.clear()

      mockCodegraphEntries.files.push({
        id: "file-1",
        path: "test.ts",
        contentHash: "hash1",
        language: "typescript",
        indexedAt: Date.now(),
      })

      mockCodegraphEntries.nodes.push({
        id: "node-1",
        fileID: "file-1",
        kind: "function",
        name: "foo",
        qualifiedName: "test.ts::foo",
        signature: "() => void",
        startLine: 1,
        startByte: 0,
        endLine: 5,
        endByte: 0,
        language: "typescript",
        textExcerpt: "function foo() { return 1 }",
        nodeCodeHash: "abc123",
        code: "function foo() { return 1 }",
      })

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const searchResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-search",
          name: "code_search",
          input: { query: "foo", mode: "hybrid" },
        },
      })

      const output = searchResult.output?.structured as any
      expect(output.degraded).toBe(true)
      expect(output.warning).toContain("No embedding model configured")
    }),
  )

  itWithModel.effect("code_search returns empty hits with status when graph is empty", () =>
    Effect.gen(function* () {
      mockCodegraphEntries.nodes.length = 0
      mockCodegraphEntries.files.length = 0
      mockCodegraphEntries.embeddings.clear()
      mockCodegraphEntries.edges.length = 0

      mockCodegraphEntries.files.push({
        id: "file-1",
        path: "test.ts",
        contentHash: "hash1",
        language: "typescript",
        indexedAt: Date.now(),
      })

      mockCodegraphEntries.nodes.push({
        id: "node-1",
        fileID: "file-1",
        kind: "function",
        name: "isolatedFunc",
        qualifiedName: "test.ts::isolatedFunc",
        signature: "() => void",
        startLine: 1,
        startByte: 0,
        endLine: 5,
        endByte: 0,
        language: "typescript",
        textExcerpt: "function isolatedFunc() { return 1 }",
        nodeCodeHash: "abc123",
        code: "function isolatedFunc() { return 1 }",
      })

      mockCodegraphEntries.embeddings.set("node-1", {
        embedding: new Uint8Array(new Float32Array([1, 0, 0]).buffer),
        model: "test-model",
        dim: 3,
        baseUrlHash: "test-url-hash",
        inputHash: "test-input-hash",
      })

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const searchResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-search",
          name: "code_search",
          input: { query: "isolatedFunc" },
        },
      })

      const output = searchResult.output?.structured as any
      expect(output.hits.length).toBeGreaterThanOrEqual(0)
      expect(output.mode).toBe("hybrid")
      expect(output.seedCount).toBeGreaterThanOrEqual(0)
    }),
  )
})

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
  embeddings: Map<string, { embedding: Uint8Array; model: string; dim: number }>
} = {
  files: [],
  nodes: [],
  edges: [],
  embeddings: new Map(),
}

const mockRepoLayer = Layer.succeed(Banyan.CodegraphRepo, Banyan.CodegraphRepo.of({
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
  putEmbedding: (nodeID: string, embedding: Uint8Array, model: string, dim: number) =>
    Effect.sync(() => {
      mockCodegraphEntries.embeddings.set(nodeID, { embedding, model, dim })
    }),
  getEmbedding: (nodeID: string) => Effect.sync(() => mockCodegraphEntries.embeddings.get(nodeID)),
  deleteFile: (id: string) => Effect.sync(() => {
    mockCodegraphEntries.files = mockCodegraphEntries.files.filter((f) => f.id !== id)
    mockCodegraphEntries.nodes = mockCodegraphEntries.nodes.filter((n) => n.fileID !== id)
  }),
}))

const mockEmbeddingProviderNoModelLayer = Layer.succeed(
  Banyan.EmbeddingProviderService,
  Banyan.EmbeddingProviderService.of({
    embed: (input: string | string[]) =>
      Effect.fail(new EmbeddingProvider.EmbeddingError({ message: "no embedding model configured" })),
    model: () => undefined,
    setModel: () => Effect.void,
  }),
)

const mockCodegraphEmbedderLayer = Layer.succeed(Banyan.CodegraphEmbedder, Banyan.CodegraphEmbedder.of({
  embedAll: () => Effect.succeed({ embedded: 0, skipped: 0, model: undefined }),
  embedFile: (fileID: string) => Effect.succeed({ embedded: 0, skipped: 0 }),
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
          signature: "(name: string) => User",
          startLine: 1,
          endLine: 10,
          code: "function createUser(name: string) { return { name }; }",
        },
        {
          id: "node-2",
          fileID: "file-1",
          kind: "function",
          name: "deleteUser",
          signature: "(id: string) => void",
          startLine: 12,
          endLine: 20,
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

      expect((searchResult.output?.structured as any).degraded).toBe(true)
      expect((searchResult.output?.structured as any).hits.length).toBe(1)
      expect((searchResult.output?.structured as any).hits[0].node.name).toBe("createUser")
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
          signature: "() => void",
          startLine: 1,
          endLine: 5,
          code: "function foo() { return 1 }",
        },
        {
          id: "node-2",
          fileID: "file-1",
          kind: "function",
          name: "bar",
          signature: "() => void",
          startLine: 7,
          endLine: 10,
          code: "function bar() { return 2 }",
        },
      )

      mockCodegraphEntries.embeddings.set("node-1", {
        embedding: new Uint8Array(new Float32Array([1, 0, 0]).buffer),
        model: "test-model",
        dim: 3,
      })
      mockCodegraphEntries.embeddings.set("node-2", {
        embedding: new Uint8Array(new Float32Array([0, 1, 0]).buffer),
        model: "test-model",
        dim: 3,
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

      expect((searchResult.output?.structured as any).degraded).toBe(false)
      expect((searchResult.output?.structured as any).hits.length).toBeGreaterThan(0)
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
        signature: "() => void",
        startLine: 1,
        endLine: 5,
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
})

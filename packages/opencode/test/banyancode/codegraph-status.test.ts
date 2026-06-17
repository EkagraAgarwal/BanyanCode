import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CodegraphStatusTools } from "../../../core/src/tool/codegraph-status"
import { ToolRegistry } from "../../../core/src/tool/registry"
import { PermissionV2 } from "../../../core/src/permission"
import { Banyan } from "../../../core/src/banyancode"
import { CodegraphBuildService } from "../../../core/src/banyancode/codegraph-build-service"
import { CodegraphIndexer } from "../../../core/src/banyancode/codegraph-indexer"
import { CodegraphAnalyzer } from "../../../core/src/banyancode/codegraph-analyzer"
import { FSUtil } from "../../../core/src/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
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

const mockCodegraphEntries: { files: Banyan.CodegraphFile[]; nodes: Banyan.CodegraphNode[]; edges: Banyan.CodegraphEdge[]; roots: Banyan.CodegraphRootRow[] } = {
  files: [],
  nodes: [],
  edges: [],
  roots: [],
}

const mockBuildState = { status: "idle" as "idle" | "running" | "completed" | "failed" | "cancelled", done: 0, total: 0, currentFile: undefined as string | undefined }

const mockRepoLayer = Layer.succeed(Banyan.CodegraphRepo, Banyan.CodegraphRepo.of({
  upsertRoot: () => Effect.void,
  getRoot: () => Effect.succeed(undefined),
  listRoots: () => Effect.sync(() => mockCodegraphEntries.roots),
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
  putEmbedding: () => Effect.void,
  getEmbedding: () => Effect.succeed(undefined),
  deleteFile: (id: string) => Effect.sync(() => {
    mockCodegraphEntries.files = mockCodegraphEntries.files.filter((f) => f.id !== id)
    mockCodegraphEntries.nodes = mockCodegraphEntries.nodes.filter((n) => n.fileID !== id)
  }),
  searchFTS: () => Effect.succeed([]),
  unresolvedEdgesFor: () => Effect.succeed([]),
  markStaleEmbeddings: () => Effect.succeed(0),
  deleteStaleFiles: () => Effect.succeed({ removed: 0 }),
  countAllEdges: () => Effect.succeed(0),
  putNodesAndEdges: () => Effect.void,
  putNodesAndEdgesBatched: () => Effect.void,
  getGraphContext: (_input: { nodeIDs: string[]; maxUpHops?: number; maxDownHops?: number; limit?: number }) =>
    Effect.succeed({ nodes: [], edges: [] }),
}))

const mockBuildServiceLayer = Layer.succeed(Banyan.CodegraphBuildService, Banyan.CodegraphBuildService.of({
  status: () => Effect.sync(() => mockBuildState),
  start: () => Effect.void,
  cancel: () => Effect.void,
  events: () => Effect.sync(() => ({ take: () => Effect.void })) as any,
}))

const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(mockPermissionLayer))
const toolLayer = Layer.mergeAll(
  CodegraphStatusTools.locationLayer,
).pipe(
  Layer.provide(registry),
  Layer.provide(mockPermissionLayer),
  Layer.provide(mockRepoLayer),
  Layer.provide(mockBuildServiceLayer),
  Layer.provide(CodegraphIndexer.defaultLayer),
  Layer.provide(CodegraphAnalyzer.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
)

const it = testEffect(Layer.mergeAll(
  mockPermissionLayer,
  registry,
  mockRepoLayer,
  mockBuildServiceLayer,
  toolLayer,
  FSUtil.defaultLayer,
  NodeFileSystem.layer,
  Database.layerFromPath(":memory:"),
  EventV2.defaultLayer,
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

describe("codegraph_status", () => {
  beforeEach(() => {
    mockCodegraphEntries.roots = []
    mockCodegraphEntries.files = []
    mockCodegraphEntries.nodes = []
    mockCodegraphEntries.edges = []
    mockBuildState.status = "idle"
    mockBuildState.done = 0
    mockBuildState.total = 0
    mockBuildState.currentFile = undefined
  })

  it.live("returns empty roots when no build has been done", () =>
    Effect.gen(function* () {
      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const result = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-status",
          name: "codegraph_status",
          input: {},
        },
      })

      const output = result.output?.structured as any
      expect(output.roots).toEqual([])
      expect(output.activeJob).toBeNull()
    }),
  )

  it.live("returns root info after a build", () =>
    Effect.gen(function* () {
      const rootRow: Banyan.CodegraphRootRow = {
        id: "root-1",
        rootPath: "/test/root",
        lastBuildAt: 1234567890,
        indexedFileCount: 42,
        nodeCount: 100,
        edgeCount: 200,
        embeddingModel: "test-model",
        parserVersion: "1.0.0",
        createdAt: 1234567800,
      }
      mockCodegraphEntries.roots.push(rootRow)

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const result = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-status",
          name: "codegraph_status",
          input: {},
        },
      })

      const output = result.output?.structured as any
      expect(output.roots.length).toBe(1)
      expect(output.roots[0].id).toBe("root-1")
      expect(output.roots[0].rootPath).toBe("/test/root")
      expect(output.roots[0].indexedFileCount).toBe(42)
      expect(output.roots[0].nodeCount).toBe(100)
      expect(output.roots[0].edgeCount).toBe(200)
      expect(output.roots[0].embeddingModel).toBe("test-model")
      expect(output.roots[0].parserVersion).toBe("1.0.0")
    }),
  )

  it.live("filters by root when input.root is provided", () =>
    Effect.gen(function* () {
      const root1: Banyan.CodegraphRootRow = {
        id: "root-1",
        rootPath: "/test/root1",
        lastBuildAt: 1234567890,
        indexedFileCount: 10,
        nodeCount: 20,
        edgeCount: 30,
        embeddingModel: null,
        parserVersion: "1.0.0",
        createdAt: 1234567800,
      }
      const root2: Banyan.CodegraphRootRow = {
        id: "root-2",
        rootPath: "/test/root2",
        lastBuildAt: 1234567891,
        indexedFileCount: 15,
        nodeCount: 25,
        edgeCount: 35,
        embeddingModel: null,
        parserVersion: "1.0.0",
        createdAt: 1234567801,
      }
      mockCodegraphEntries.roots.push(root1, root2)

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const result = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-status",
          name: "codegraph_status",
          input: { root: "/test/root1" },
        },
      })

      const output = result.output?.structured as any
      expect(output.roots.length).toBe(1)
      expect(output.roots[0].id).toBe("root-1")
    }),
  )

  it.live("reports active job when build is running", () =>
    Effect.gen(function* () {
      mockBuildState.status = "running"
      mockBuildState.done = 5
      mockBuildState.total = 10
      mockBuildState.currentFile = "/test/file.ts"

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const result = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-status",
          name: "codegraph_status",
          input: {},
        },
      })

      const output = result.output?.structured as any
      expect(output.activeJob).not.toBeNull()
      expect(output.activeJob!.state).toBe("running")
      expect(output.activeJob!.done).toBe(5)
      expect(output.activeJob!.total).toBe(10)
      expect(output.activeJob!.currentFile).toBe("/test/file.ts")
    }),
  )

  it.live("returns null activeJob when idle", () =>
    Effect.gen(function* () {
      mockBuildState.status = "idle"
      mockBuildState.done = 0
      mockBuildState.total = 0

      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const result = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-status",
          name: "codegraph_status",
          input: {},
        },
      })

      const output = result.output?.structured as any
      expect(output.activeJob).toBeNull()
    }),
  )
})

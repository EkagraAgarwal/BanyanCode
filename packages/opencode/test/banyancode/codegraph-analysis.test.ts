import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Banyan } from "../../../core/src/banyancode"
import { CodegraphAnalyzer } from "../../../core/src/banyancode/codegraph-analyzer"
import { testEffect } from "../lib/effect"

const mockCodegraphEntries: { files: Banyan.CodegraphFile[]; nodes: Banyan.CodegraphNode[]; edges: Banyan.CodegraphEdge[] } = {
  files: [],
  nodes: [],
  edges: [],
}

const makeMockRepoLayer = () =>
  Layer.effect(
    Banyan.CodegraphRepo,
    Effect.gen(function* () {
      return Banyan.CodegraphRepo.of({
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
        listAllEdges: () => Effect.sync(() => mockCodegraphEntries.edges),
        listEdgesByNode: (nodeID: string) => Effect.sync(() => mockCodegraphEntries.edges.filter((e) => e.fromNodeID === nodeID)),
        edgesFrom: (nodeID: string) => Effect.sync(() => mockCodegraphEntries.edges.filter((e) => e.fromNodeID === nodeID)),
        edgesTo: (nodeID: string) => Effect.sync(() => mockCodegraphEntries.edges.filter((e) => e.toNodeID === nodeID)),
        putEmbedding: () => Effect.void,
        getEmbedding: () => Effect.succeed(undefined),
        deleteFile: (id: string) => Effect.sync(() => {
          mockCodegraphEntries.files = mockCodegraphEntries.files.filter((f) => f.id !== id)
          mockCodegraphEntries.nodes = mockCodegraphEntries.nodes.filter((n) => n.fileID !== id)
        }),
        clearAll: () => Effect.sync(() => {
          mockCodegraphEntries.files = []
          mockCodegraphEntries.nodes = []
          mockCodegraphEntries.edges = []
        }),
        getMeta: () => Effect.succeed(undefined),
        setMeta: () => Effect.void,
        bumpVersion: () => Effect.succeed({ graphVersion: 1, coverage: 1 }),
        resetEmbeddingsTable: () => Effect.succeed(undefined),
        searchByVector: () => Effect.succeed([]),
        searchNodes: () => Effect.succeed([]),
        countNodes: () => Effect.succeed(0),
        countEdges: () => Effect.succeed(0),
        countFiles: () => Effect.succeed(0),
      })
    }),
  )

const fileA = { id: "file-a", path: "/a.ts", contentHash: "hash-a", language: "typescript", indexedAt: 1 }
const fileB = { id: "file-b", path: "/b.ts", contentHash: "hash-b", language: "typescript", indexedAt: 1 }

const nodePrompt = { id: "n-prompt", fileID: "file-a", kind: "function" as const, name: "SessionV2.prompt", signature: "prompt()", startLine: 1, endLine: 10 }
const nodeBuild = { id: "n-build", fileID: "file-a", kind: "function" as const, name: "build", signature: "build()", startLine: 11, endLine: 20 }
const nodeIndex = { id: "n-index", fileID: "file-a", kind: "function" as const, name: "index", signature: "index()", startLine: 21, endLine: 30 }
const nodeCaller1 = { id: "n-caller1", fileID: "file-b", kind: "function" as const, name: "caller1", signature: "caller1()", startLine: 1, endLine: 5 }
const nodeCaller2 = { id: "n-caller2", fileID: "file-b", kind: "function" as const, name: "caller2", signature: "caller2()", startLine: 6, endLine: 10 }
const nodeDep1 = { id: "n-dep1", fileID: "file-b", kind: "function" as const, name: "dep1", signature: "dep1()", startLine: 11, endLine: 15 }
const nodeDep2 = { id: "n-dep2", fileID: "file-b", kind: "function" as const, name: "dep2", signature: "dep2()", startLine: 16, endLine: 20 }
const nodeTransitive = { id: "n-transitive", fileID: "file-b", kind: "function" as const, name: "transitive", signature: "transitive()", startLine: 21, endLine: 25 }

describe("codegraph analyzer", () => {
  beforeEach(() => {
    mockCodegraphEntries.files = [fileA, fileB]
    mockCodegraphEntries.nodes = [nodePrompt, nodeBuild, nodeIndex, nodeCaller1, nodeCaller2, nodeDep1, nodeDep2, nodeTransitive]
    mockCodegraphEntries.edges = [
      { id: "e1", fromNodeID: "n-caller1", toNodeID: "n-prompt", kind: "calls" as const },
      { id: "e2", fromNodeID: "n-caller2", toNodeID: "n-prompt", kind: "calls" as const },
      { id: "e3", fromNodeID: "n-prompt", toNodeID: "n-build", kind: "calls" as const },
      { id: "e4", fromNodeID: "n-build", toNodeID: "n-index", kind: "calls" as const },
      { id: "e5", fromNodeID: "n-dep1", toNodeID: "n-prompt", kind: "references" as const },
      { id: "e6", fromNodeID: "n-dep2", toNodeID: "n-dep1", kind: "calls" as const },
      { id: "e7", fromNodeID: "n-transitive", toNodeID: "n-dep2", kind: "calls" as const },
    ]
  })

  const it = testEffect(CodegraphAnalyzer.layer.pipe(Layer.provide(makeMockRepoLayer())))

  it.live("callers returns nodes that point to the target", () =>
    Effect.gen(function* () {
      const analyzer = yield* CodegraphAnalyzer.Service
      const result = yield* analyzer.callers({ function: "SessionV2.prompt" })
      const ids = result.map((n) => n.id)
      expect(ids).toContain("n-caller1")
      expect(ids).toContain("n-caller2")
      expect(ids).toContain("n-dep1")
      expect(ids).not.toContain("n-prompt")
    }),
  )

  it.live("callers returns empty for node with no callers", () =>
    Effect.gen(function* () {
      const analyzer = yield* CodegraphAnalyzer.Service
      const result = yield* analyzer.callers({ function: "transitive" })
      expect(result).toHaveLength(0)
    }),
  )

  it.live("dependents returns nodes the target points to", () =>
    Effect.gen(function* () {
      const analyzer = yield* CodegraphAnalyzer.Service
      const result = yield* analyzer.dependents({ function: "SessionV2.prompt" })
      const ids = result.map((n) => n.id)
      expect(ids).toContain("n-build")
      expect(ids).not.toContain("n-caller1")
    }),
  )

  it.live("impact returns full transitive dependent set", () =>
    Effect.gen(function* () {
      const analyzer = yield* CodegraphAnalyzer.Service
      const result = yield* analyzer.impact({ function: "SessionV2.prompt" })
      const allIds = [...result.dependents.map((n) => n.id), ...result.transitive.map((n) => n.id)]
      expect(allIds).toContain("n-build")
      expect(allIds).toContain("n-index")
      expect(allIds).toContain("n-dep1")
      expect(allIds).toContain("n-dep2")
      expect(allIds).toContain("n-transitive")
    }),
  )

  it.live("function-name lookup resolves to the right node", () =>
    Effect.gen(function* () {
      const analyzer = yield* CodegraphAnalyzer.Service
      const result = yield* analyzer.callers({ function: "index" })
      const ids = result.map((n) => n.id)
      expect(ids).toContain("n-build")
    }),
  )

  it.live("walkTransitive upstream finds all callers", () =>
    Effect.gen(function* () {
      const analyzer = yield* CodegraphAnalyzer.Service
      const result = yield* analyzer.walkTransitive({ nodeID: "n-index", direction: "upstream" })
      const ids = result.map((n) => n.id)
      expect(ids).toContain("n-build")
      expect(ids).toContain("n-prompt")
    }),
  )

  it.live("walkTransitive downstream finds all dependencies", () =>
    Effect.gen(function* () {
      const analyzer = yield* CodegraphAnalyzer.Service
      const result = yield* analyzer.walkTransitive({ nodeID: "n-prompt", direction: "downstream" })
      const ids = result.map((n) => n.id)
      expect(ids).toContain("n-build")
      expect(ids).toContain("n-index")
    }),
  )

  it.live("performance - impact completes within 1 second", () =>
    Effect.gen(function* () {
      const analyzer = yield* CodegraphAnalyzer.Service
      const start = Date.now()
      yield* analyzer.impact({ function: "SessionV2.prompt" })
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(1000)
    }),
  )
})

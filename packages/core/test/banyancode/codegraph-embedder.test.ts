import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { CodegraphRepo } from "../../src/banyancode/codegraph-repo"
import { CodegraphEmbedder } from "../../src/banyancode/codegraph-embedder"
import { EmbeddingProvider } from "../../src/banyancode/embedding-provider"
import { FSUtil } from "../../src/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"

process.env.BANYANCODE_ENABLE = "1"

// ---------------------------------------------------------------------------
// Mock provider that succeeds CodegraphEmbedder.Service (no extra deps)
// ---------------------------------------------------------------------------

const makeMockEmbeddingProviderLayer = (modelName: string, baseUrl = "https://api.openai.com/v1") =>
  Layer.succeed(EmbeddingProvider.EmbeddingProviderService, {
    embed: (input: string | string[]) => {
      const arr = Array.isArray(input) ? input : [input]
      return Effect.succeed(arr.map(() => new Float32Array(1536)))
    },
    model: () => modelName,
    setModel: () => Effect.void,
    inputHash: (text: string) => createHash("sha256").update(text).digest("hex"),
    config: () => ({ baseUrl, apiKey: undefined, dimensions: 1536, batchSize: 64 }),
  })

describe("CodegraphEmbedder staleness checks", () => {
  test("embedAll skips when model + baseUrl + inputHash all match", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const filePath = path.join(tmp.path, "a.ts")
    await fs.writeFile(filePath, "export function foo() { return 1; }\n", "utf-8")

    const mockProviderLayer = makeMockEmbeddingProviderLayer("model-x")

    const testLayer = CodegraphEmbedder.layer.pipe(
      Layer.provideMerge(CodegraphRepo.layer),
      Layer.provideMerge(dbLayer),
      Layer.provideMerge(FSUtil.defaultLayer),
      Layer.provideMerge(mockProviderLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const embedder = yield* CodegraphEmbedder.Service

        const rootID = "root_1"
        const fileID = "file_1"
        const nodeID = "node_1"

        yield* repo.upsertRoot({ id: rootID, rootPath: tmp.path })
        yield* repo.putFile({
          id: fileID,
          rootID,
          path: "a.ts",
          contentHash: "hash1",
          byteSize: 40,
          language: "typescript",
          indexedAt: Date.now(),
        })
        yield* repo.putNode({
          id: nodeID,
          fileID,
          kind: "function",
          name: "foo",
          qualifiedName: "foo",
          startLine: 1,
          startByte: 0,
          endLine: 1,
          endByte: 40,
          language: "typescript",
          signature: "foo()",
          doc: undefined,
          textExcerpt: "export function foo() { return 1; }",
          nodeCodeHash: "nchash",
          code: "export function foo() { return 1; }",
        })

        // Embed with model "model-x", baseUrl "https://api.openai.com/v1"
        yield* embedder.embedNode({
          id: nodeID,
          fileID,
          kind: "function",
          name: "foo",
          qualifiedName: "foo",
          startLine: 1,
          startByte: 0,
          endLine: 1,
          endByte: 40,
          language: "typescript",
          signature: "foo()",
          doc: undefined,
          textExcerpt: "export function foo() { return 1; }",
          nodeCodeHash: "nchash",
          code: "export function foo() { return 1; }",
        })

        // Second embedAll should skip because nothing changed
        const result = yield* embedder.embedAll()
        expect(result.skipped).toBeGreaterThan(0)
        expect(result.embedded).toBe(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("embedAll re-embeds when model changes", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const filePath = path.join(tmp.path, "a.ts")
    await fs.writeFile(filePath, "export function foo() { return 1; }\n", "utf-8")

    // Embed with model A first
    const mockProviderLayerA = makeMockEmbeddingProviderLayer("model-a")
    const testLayerA = CodegraphEmbedder.layer.pipe(
      Layer.provideMerge(CodegraphRepo.layer),
      Layer.provideMerge(dbLayer),
      Layer.provideMerge(FSUtil.defaultLayer),
      Layer.provideMerge(mockProviderLayerA),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const embedder = yield* CodegraphEmbedder.Service

        const rootID = "root_1"
        const fileID = "file_1"
        const nodeID = "node_1"

        yield* repo.upsertRoot({ id: rootID, rootPath: tmp.path })
        yield* repo.putFile({
          id: fileID,
          rootID,
          path: "a.ts",
          contentHash: "hash1",
          byteSize: 40,
          language: "typescript",
          indexedAt: Date.now(),
        })
        yield* repo.putNode({
          id: nodeID,
          fileID,
          kind: "function",
          name: "foo",
          qualifiedName: "foo",
          startLine: 1,
          startByte: 0,
          endLine: 1,
          endByte: 40,
          language: "typescript",
          signature: "foo()",
          doc: undefined,
          textExcerpt: "export function foo() { return 1; }",
          nodeCodeHash: "nchash",
          code: "export function foo() { return 1; }",
        })

        // Embed with model A
        yield* embedder.embedNode({
          id: nodeID,
          fileID,
          kind: "function",
          name: "foo",
          qualifiedName: "foo",
          startLine: 1,
          startByte: 0,
          endLine: 1,
          endByte: 40,
          language: "typescript",
          signature: "foo()",
          doc: undefined,
          textExcerpt: "export function foo() { return 1; }",
          nodeCodeHash: "nchash",
          code: "export function foo() { return 1; }",
        })

        const emb = yield* repo.getEmbedding(nodeID)
        expect(emb?.model).toBe("model-a")
      }).pipe(Effect.provide(testLayerA), Effect.provide(dbLayer), Effect.scoped),
    )

    // Now embed with model B — should re-embed (not skip) because model changed
    const mockProviderLayerB = makeMockEmbeddingProviderLayer("model-b")
    const testLayerB = CodegraphEmbedder.layer.pipe(
      Layer.provideMerge(CodegraphRepo.layer),
      Layer.provideMerge(dbLayer),
      Layer.provideMerge(FSUtil.defaultLayer),
      Layer.provideMerge(mockProviderLayerB),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const embedder = yield* CodegraphEmbedder.Service

        const result = yield* embedder.embedAll()
        expect(result.model).toBe("model-b")
      }).pipe(Effect.provide(testLayerB), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("embedAll re-embeds when baseUrl changes", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const filePath = path.join(tmp.path, "a.ts")
    await fs.writeFile(filePath, "export function foo() { return 1; }\n", "utf-8")

    // Embed with baseUrl A first
    const mockProviderLayerA = makeMockEmbeddingProviderLayer("model-x")
    const testLayerA = CodegraphEmbedder.layer.pipe(
      Layer.provideMerge(CodegraphRepo.layer),
      Layer.provideMerge(dbLayer),
      Layer.provideMerge(FSUtil.defaultLayer),
      Layer.provideMerge(mockProviderLayerA),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const embedder = yield* CodegraphEmbedder.Service

        const rootID = "root_1"
        const fileID = "file_1"
        const nodeID = "node_1"

        yield* repo.upsertRoot({ id: rootID, rootPath: tmp.path })
        yield* repo.putFile({
          id: fileID,
          rootID,
          path: "a.ts",
          contentHash: "hash1",
          byteSize: 40,
          language: "typescript",
          indexedAt: Date.now(),
        })
        yield* repo.putNode({
          id: nodeID,
          fileID,
          kind: "function",
          name: "foo",
          qualifiedName: "foo",
          startLine: 1,
          startByte: 0,
          endLine: 1,
          endByte: 40,
          language: "typescript",
          signature: "foo()",
          doc: undefined,
          textExcerpt: "export function foo() { return 1; }",
          nodeCodeHash: "nchash",
          code: "export function foo() { return 1; }",
        })

        yield* embedder.embedNode({
          id: nodeID,
          fileID,
          kind: "function",
          name: "foo",
          qualifiedName: "foo",
          startLine: 1,
          startByte: 0,
          endLine: 1,
          endByte: 40,
          language: "typescript",
          signature: "foo()",
          doc: undefined,
          textExcerpt: "export function foo() { return 1; }",
          nodeCodeHash: "nchash",
          code: "export function foo() { return 1; }",
        })

        const emb = yield* repo.getEmbedding(nodeID)
        expect(emb?.model).toBe("model-x")
      }).pipe(Effect.provide(testLayerA), Effect.provide(dbLayer), Effect.scoped),
    )

    // Embed with baseUrl B — should re-embed because baseUrl changed
    const mockProviderLayerB = makeMockEmbeddingProviderLayer("model-x", "https://api.anthropic.com/v1")
    const testLayerB = CodegraphEmbedder.layer.pipe(
      Layer.provideMerge(CodegraphRepo.layer),
      Layer.provideMerge(dbLayer),
      Layer.provideMerge(FSUtil.defaultLayer),
      Layer.provideMerge(mockProviderLayerB),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const embedder = yield* CodegraphEmbedder.Service

        const result = yield* embedder.embedAll()
        expect(result.embedded).toBeGreaterThan(0)
      }).pipe(Effect.provide(testLayerB), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("embedAll re-embeds when inputHash changes (file content changed)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const filePath = path.join(tmp.path, "a.ts")
    await fs.writeFile(filePath, "export function foo() { return 1; }\n", "utf-8")

    const mockProviderLayer = makeMockEmbeddingProviderLayer("model-x")

    const testLayer = CodegraphEmbedder.layer.pipe(
      Layer.provideMerge(CodegraphRepo.layer),
      Layer.provideMerge(dbLayer),
      Layer.provideMerge(FSUtil.defaultLayer),
      Layer.provideMerge(mockProviderLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const embedder = yield* CodegraphEmbedder.Service

        const rootID = "root_1"
        const fileID = "file_1"
        const nodeID = "node_1"

        yield* repo.upsertRoot({ id: rootID, rootPath: tmp.path })
        yield* repo.putFile({
          id: fileID,
          rootID,
          path: "a.ts",
          contentHash: "hash1",
          byteSize: 40,
          language: "typescript",
          indexedAt: Date.now(),
        })
        const node = {
          id: nodeID,
          fileID,
          kind: "function" as const,
          name: "foo",
          qualifiedName: "foo",
          startLine: 1,
          startByte: 0,
          endLine: 1,
          endByte: 40,
          language: "typescript" as const,
          signature: "foo()",
          doc: undefined,
          textExcerpt: "export function foo() { return 1; }",
          nodeCodeHash: "nchash",
          code: "export function foo() { return 1; }",
        }
        yield* repo.putNode(node)
        yield* embedder.embedNode(node)

        // Update the node's textExcerpt to simulate content change
        const updatedNode = { ...node, textExcerpt: "export function bar() { return 2; }" }
        yield* repo.putNode(updatedNode)

        const result = yield* embedder.embedAll()
        // inputHash changed so it should embed (not skip)
        expect(result.embedded).toBeGreaterThan(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

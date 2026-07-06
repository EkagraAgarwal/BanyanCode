import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import path from "path"
import { Effect, Layer } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolCall } from "@opencode-ai/llm"
import { tmpdir } from "../fixture/tmpdir"
import {
  InputRemove,
  OutputRemove,
  makeCodegraphRemoveTool,
  name_remove,
} from "../../src/tool/codegraph"
import type { Interface as CodegraphRepoInterface } from "../../src/banyancode/codegraph-repo"
import type { Interface as PermissionV2Interface } from "../../src/permission"

process.env.BANYANCODE_ENABLE = "1"

const sessionID = randomUUID()
const messageID = randomUUID()

const makeContext = (): Tool.Context => ({
  sessionID: sessionID as Tool.Context["sessionID"],
  agent: "build" as Tool.Context["agent"],
  assistantMessageID: messageID as Tool.Context["assistantMessageID"],
  toolCallID: randomUUID(),
})

const makeCall = (input: unknown): ToolCall => ({
  type: "tool-call",
  id: randomUUID(),
  name: name_remove,
  input,
})

const mockPermission: PermissionV2Interface = {
  assert: () => Effect.void,
  ask: () => Effect.void,
  reply: () => Effect.void,
  configured: () => Effect.void,
  list: () => Effect.succeed([]),
  get: () => Effect.void,
  forSession: () => Effect.void,
} as unknown as PermissionV2Interface

const seedRepo = (repo: CodegraphRepoInterface) =>
  Effect.gen(function* () {
    yield* repo.putFile({
      id: "file-1",
      path: "/test/file.ts",
      contentHash: "abc123",
      language: "typescript",
      indexedAt: Date.now(),
    })
    yield* repo.putNode({
      id: "node-1",
      fileID: "file-1",
      kind: "function",
      name: "testFn",
      startLine: 1,
      endLine: 5,
    })
    yield* repo.putEdge({
      id: "edge-1",
      fromNodeID: "node-1",
      toNodeID: "node-1",
      kind: "calls",
    })
    yield* repo.setMeta({
      id: "singleton",
      graphBuiltAt: Date.now(),
      graphVersion: 1,
      graphCoverage: 1.0,
      totalFiles: 1,
      totalNodes: 1,
      totalEdges: 1,
      schemaVersion: 1,
    })
  })

const settleWithRepo = async (
  dbPath: string,
  input: unknown,
  seed: boolean,
) => {
  process.env.OPENCODE_DB = dbPath

  const { CodegraphRepo } = await import("../../src/banyancode/codegraph-repo")
  const { Database } = await import("@opencode-ai/core/database/database")
  const { PermissionV2 } = await import("../../src/permission")

  const dbLayer = Database.layerFromPath(dbPath)
  const repoLayer = CodegraphRepo.defaultLayer.pipe(Layer.provide(dbLayer))
  const permissionLayer = Layer.succeed(
    PermissionV2.Service,
    mockPermission as never,
  )

  const effect = Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service
    if (seed) yield* seedRepo(repo as unknown as CodegraphRepoInterface)
    const tool = makeCodegraphRemoveTool({
      permission: (yield* PermissionV2.Service) as unknown as Parameters<typeof makeCodegraphRemoveTool>[0]["permission"],
      repo: repo as unknown as Parameters<typeof makeCodegraphRemoveTool>[0]["repo"],
    })
    const settleResult = yield* Tool.settle(tool, makeCall(input), makeContext())
    const afterCounts = {
      files: yield* repo.countFiles(),
      nodes: yield* repo.countNodes(),
      edges: yield* repo.countEdges(),
    }
    return { result: settleResult, afterCounts }
  }).pipe(Effect.provide(repoLayer), Effect.provide(permissionLayer), Effect.scoped)

  return await Effect.runPromise(effect as unknown as Effect.Effect<unknown, never, never>)
}

describe("codegraph-remove tool", () => {
  test("InputRemove / OutputRemove / name_remove are exported with correct shape", () => {
    expect(name_remove).toBe("codegraph_remove")
    expect(InputRemove.fields).toHaveProperty("dropFile")
    expect(OutputRemove.fields).toHaveProperty("status")
    expect(OutputRemove.fields).toHaveProperty("sizeBefore")
    expect(OutputRemove.fields).toHaveProperty("sizeAfter")
    expect(OutputRemove.fields).toHaveProperty("freedBytes")
  })

  test("execute returns status='removed' and wipes all graph tables when graph is non-empty", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "codegraph.sqlite")
    const data = (await settleWithRepo(dbPath, { dropFile: false }, true)) as {
      result: { structured: { status: "removed" | "empty"; sizeBefore: number; sizeAfter: number; freedBytes: number } }
      afterCounts: { files: number; nodes: number; edges: number }
    }

    expect(data.result.structured.status).toBe("removed")
    expect(data.result.structured.sizeBefore).toBeGreaterThan(0)
    expect(data.result.structured.freedBytes).toBeGreaterThanOrEqual(0)
    expect(data.result.structured.sizeAfter).toBeLessThanOrEqual(data.result.structured.sizeBefore)

    expect(data.afterCounts.files).toBe(0)
    expect(data.afterCounts.nodes).toBe(0)
    expect(data.afterCounts.edges).toBe(0)
  })

  test("execute returns status='empty' and zero freed bytes when graph was already empty", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "codegraph.sqlite")
    const data = (await settleWithRepo(dbPath, { dropFile: false }, false)) as {
      result: { structured: { status: "removed" | "empty"; sizeBefore: number; sizeAfter: number; freedBytes: number } }
    }

    expect(data.result.structured.status).toBe("empty")
    expect(data.result.structured.freedBytes).toBe(0)
  })

  test("toModelOutput formats the freed-bytes message for the model", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "codegraph.sqlite")
    const data = (await settleWithRepo(dbPath, { dropFile: false }, true)) as {
      result: { content: ReadonlyArray<{ type: string; text?: string }> }
    }

    expect(data.result.content[0]?.type).toBe("text")
    expect(data.result.content[0]?.text).toContain("Codegraph index removed")
    expect(data.result.content[0]?.text).toContain("Freed")
  })

  test("toModelOutput reports 'already empty' when the graph was empty", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "codegraph.sqlite")
    const data = (await settleWithRepo(dbPath, { dropFile: false }, false)) as {
      result: { content: ReadonlyArray<{ type: string; text?: string }> }
    }

    expect(data.result.content[0]?.text).toBe("Codegraph index was already empty.")
  })

  test("dropFile=false (default) does not delete the banyancode.db file", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "codegraph.sqlite")
    const data = (await settleWithRepo(dbPath, { dropFile: false }, true)) as {
      result: { structured: { status: "removed" | "empty" } }
    }
    expect(data.result.structured.status).toBe("removed")
    expect(existsSync(dbPath)).toBe(true)
  })
})

import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolCall } from "@opencode-ai/llm"
import { tmpdir } from "../fixture/tmpdir"
import { Database } from "@opencode-ai/core/database/database"
import {
  Output as StalenessOutput,
  makeCodegraphStalenessTool,
  name as stalenessName,
} from "../../src/tool/codegraph-staleness"
import {
  Output as MemoryStatsOutput,
  makeMemoryStatsTool,
  name as memoryStatsName,
} from "../../src/tool/memory-stats"
import {
  Output as MeshStatusOutput,
  makeMeshStatusTool,
  name as meshStatusName,
} from "../../src/tool/mesh-status"
import {
  Service as CodegraphRepo,
  defaultLayer as codegraphRepoDefaultLayer,
} from "../../src/banyancode/codegraph-repo"
import type { Interface as CodegraphRepoInterface } from "../../src/banyancode/codegraph-repo"
import {
  Service as MemoryRepo,
  defaultLayer as memoryRepoDefaultLayer,
} from "../../src/banyancode/memory-repo"
import type { CodegraphFile } from "../../src/banyancode/types"
import { BanyanToolsManifest } from "../../src/banyancode/banyan-tools-manifest"
import type { PermissionV2 } from "../../src/permission"

process.env.BANYANCODE_ENABLE = "1"

const sessionID = randomUUID()
const messageID = randomUUID()

const makeContext = (): Tool.Context => ({
  sessionID: sessionID as Tool.Context["sessionID"],
  agent: "build" as Tool.Context["agent"],
  assistantMessageID: messageID as Tool.Context["assistantMessageID"],
  toolCallID: randomUUID(),
})

const makeCall = (name: string, input: unknown): ToolCall => ({
  type: "tool-call",
  id: randomUUID(),
  name,
  input,
})

const mockPermission: PermissionV2.Interface = {
  assert: () => Effect.void,
  ask: () => Effect.void,
  reply: () => Effect.void,
  configured: () => Effect.void,
  list: () => Effect.succeed([]),
  get: () => Effect.void,
  forSession: () => Effect.void,
} as unknown as PermissionV2.Interface

const seedFile = (repo: CodegraphRepoInterface, file: CodegraphFile) => repo.putFile(file)

describe("codegraph_staleness tool", () => {
  test("Input / Output / name are exported with correct shape", () => {
    expect(stalenessName).toBe("codegraph_staleness")
    expect(StalenessOutput.fields).toHaveProperty("staleFiles")
    expect(StalenessOutput.fields).toHaveProperty("totalFiles")
    expect(StalenessOutput.fields).toHaveProperty("topStale")
  })

  test("counts stale files and lists the stale path", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "staleness.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))

    const { structured } = (await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo
        // Stale: mtime newer than indexed_at.
        yield* seedFile(repo, {
          id: "file-stale",
          path: "packages/core/src/stale.ts",
          contentHash: "stale",
          language: "typescript",
          indexedAt: 100,
          mtimeMs: 200,
        })
        // Fresh: mtime older than indexed_at.
        yield* seedFile(repo, {
          id: "file-fresh",
          path: "packages/core/src/fresh.ts",
          contentHash: "fresh",
          language: "typescript",
          indexedAt: 300,
          mtimeMs: 100,
        })
        const tool = makeCodegraphStalenessTool({
          permission: mockPermission,
          repo,
        })
        return yield* Tool.settle(tool, makeCall(stalenessName, {}), makeContext())
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )) as { structured: Schema.Schema.Type<typeof StalenessOutput> }

    expect(structured.staleFiles).toBe(1)
    expect(structured.totalFiles).toBe(2)
    expect(structured.topStale).toHaveLength(1)
    expect(structured.topStale[0]?.path).toBe("packages/core/src/stale.ts")
    expect(structured.topStale[0]?.mtimeMs).toBe(200)
    expect(structured.topStale[0]?.indexedAt).toBe(100)
  })

  test("returns zeros when no graph is indexed", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "staleness-empty.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))

    const { structured } = (await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo
        const tool = makeCodegraphStalenessTool({
          permission: mockPermission,
          repo,
        })
        return yield* Tool.settle(tool, makeCall(stalenessName, {}), makeContext())
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )) as { structured: Schema.Schema.Type<typeof StalenessOutput> }

    expect(structured.staleFiles).toBe(0)
    expect(structured.totalFiles).toBe(0)
    expect(structured.topStale).toEqual([])
  })
})

describe("memory_stats tool", () => {
  test("Input / Output / name are exported with correct shape", () => {
    expect(memoryStatsName).toBe("memory_stats")
    expect(MemoryStatsOutput.fields).toHaveProperty("global")
    expect(MemoryStatsOutput.fields).toHaveProperty("session")
    expect(MemoryStatsOutput.fields).toHaveProperty("totalBytes")
    expect(MemoryStatsOutput.fields).toHaveProperty("quotaBytes")
  })

  test("reports counts and bytes for stored entries", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-stats.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = memoryRepoDefaultLayer.pipe(Layer.provide(dbLayer))

    const { structured } = (await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* MemoryRepo
        yield* repo.put({
          id: "global-1",
          key: "fact:one",
          value: { note: "hello" },
          scope: "global",
        })
        // Session-scoped row with a blank session id — the subset
        // `list("session", undefined)` reads (blank/orphan session rows).
        yield* repo.put({
          id: "session-1",
          key: "fact:two",
          value: { note: "world" },
          scope: "session",
          sessionID: "",
        })
        const tool = makeMemoryStatsTool({
          permission: mockPermission,
          repo,
        })
        return yield* Tool.settle(tool, makeCall(memoryStatsName, {}), makeContext())
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )) as { structured: Schema.Schema.Type<typeof MemoryStatsOutput> }

    expect(structured.global.entries).toBe(1)
    expect(structured.session.entries).toBe(1)
    expect(structured.global.bytes).toBeGreaterThan(0)
    expect(structured.session.bytes).toBeGreaterThan(0)
    expect(structured.totalBytes).toBe(structured.global.bytes + structured.session.bytes)
    expect(structured.quotaBytes).toBe(100 * 1024 * 1024)
  })
})

describe("mesh_status tool", () => {
  test("Input / Output / name are exported with correct shape", () => {
    expect(meshStatusName).toBe("mesh_status")
    expect(MeshStatusOutput.fields).toHaveProperty("agents")
    expect(MeshStatusOutput.fields).toHaveProperty("recentActivity")
  })

  test("returns the output shape (empty when no coordinator is in scope)", async () => {
    const { structured } = (await Effect.runPromise(
      Effect.gen(function* () {
        const tool = makeMeshStatusTool({ permission: mockPermission })
        return yield* Tool.settle(tool, makeCall(meshStatusName, {}), makeContext())
      }),
    )) as { structured: Schema.Schema.Type<typeof MeshStatusOutput> }

    expect(Array.isArray(structured.agents)).toBe(true)
    expect(Array.isArray(structured.recentActivity)).toBe(true)
  })
})

describe("diagnostic tools manifest registration", () => {
  test("all three tool ids appear in the manifest public list", () => {
    const ids = BanyanToolsManifest.BANYAN_PUBLIC_TOOL_IDS
    expect(ids).toContain("codegraph_staleness")
    expect(ids).toContain("memory_stats")
    expect(ids).toContain("mesh_status")
  })
})

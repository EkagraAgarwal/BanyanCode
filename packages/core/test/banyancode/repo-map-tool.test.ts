import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolCall } from "@opencode-ai/llm"
import { tmpdir } from "../fixture/tmpdir"
import {
  Input as RepoMapInput,
  Output as RepoMapOutput,
  makeRepoMapTool,
  name as repoMapName,
} from "../../src/tool/repo-map"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import {
  Service as CodegraphRepo,
  defaultLayer as codegraphRepoDefaultLayer,
} from "../../src/banyancode/codegraph-repo"
import type { Interface as CodegraphRepoInterface } from "../../src/banyancode/codegraph-repo"
import {
  Service as RepoMapService,
  defaultLayer as repoMapServiceDefaultLayer,
} from "../../src/banyancode/repo-map-service"
import type { CodegraphFile, CodegraphNode } from "../../src/banyancode/types"
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

const makeCall = (input: unknown): ToolCall => ({
  type: "tool-call",
  id: randomUUID(),
  name: repoMapName,
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

const seed = (repo: CodegraphRepoInterface) =>
  Effect.gen(function* () {
    const file: CodegraphFile = {
      id: "file-1",
      path: "packages/core/src/feature.ts",
      contentHash: "abc",
      language: "typescript",
      indexedAt: 1,
    }
    const node: CodegraphNode = {
      id: "node-1",
      fileID: "file-1",
      kind: "function",
      name: "doWork",
      signature: "function doWork(): void",
      startLine: 1,
      endLine: 5,
    }
    yield* repo.putFile(file)
    yield* repo.putNode(node)
    yield* repo.setMeta({
      id: "singleton",
      schemaVersion: 1,
      graphVersion: 7,
      totalFiles: 1,
      totalNodes: 1,
      totalEdges: 0,
      graphCoverage: 1,
      graphBuiltAt: 1,
      indexedRoot: "/",
    })
  })

const settle = async (
  dbPath: string,
  input: Schema.Schema.Type<typeof RepoMapInput>,
) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const repoLayer = codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))
  const mapLayer = repoMapServiceDefaultLayer.pipe(Layer.provide(codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))))
  return await Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* CodegraphRepo
      const map = yield* RepoMapService
      yield* seed(repo)
      const tool = makeRepoMapTool({
        permission: mockPermission,
        repo,
        map,
      })
      return yield* Tool.settle(tool, makeCall(input), makeContext())
    }).pipe(Effect.provide(Layer.mergeAll(mapLayer, repoLayer)), Effect.scoped),
  ) as { structured: Schema.Schema.Type<typeof RepoMapOutput> }
}

describe("banyan_repo_map tool", () => {
  test("Input / Output / name are exported with correct shape", () => {
    expect(repoMapName).toBe("banyan_repo_map")
    expect(RepoMapInput.fields).toHaveProperty("root")
    expect(RepoMapInput.fields).toHaveProperty("path")
    expect(RepoMapInput.fields).toHaveProperty("query")
    expect(RepoMapInput.fields).toHaveProperty("limit")
    expect(RepoMapOutput.fields).toHaveProperty("mode")
    expect(RepoMapOutput.fields).toHaveProperty("packages")
  })

  test("returns overview mode for a root query", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "tool.db")
    const { structured } = await settle(dbPath, { root: "/repo" })
    expect(structured.mode).toBe("overview")
    expect(structured.graphVersion).toBe(7)
    expect(structured.totalNodes).toBe(1)
  })

  test("returns detail mode for a path query", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "tool.db")
    const { structured } = await settle(dbPath, { path: "packages/core/src/feature.ts" })
    expect(structured.mode).toBe("detail")
    expect(structured.details?.path).toBe("packages/core/src/feature.ts")
    expect(structured.details?.symbols.length).toBe(1)
    expect(structured.details?.symbols[0]?.name).toBe("doWork")
  })

  test("returns search mode for a query", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "tool.db")
    const { structured } = await settle(dbPath, { query: "doWork" })
    expect(structured.mode).toBe("search")
    expect(structured.search?.length).toBeGreaterThan(0)
    expect(structured.search?.[0]?.name).toBe("doWork")
  })

  test("fails when no root / path / query provided", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "tool.db")
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo
        const map = yield* RepoMapService
        yield* seed(repo)
        const tool = makeRepoMapTool({
          permission: mockPermission,
          repo,
          map,
        })
        return yield* Tool.settle(tool, makeCall({}), makeContext())
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            repoMapServiceDefaultLayer.pipe(Layer.provide(codegraphRepoDefaultLayer.pipe(Layer.provide(Database.layerFromPath(dbPath))))),
            codegraphRepoDefaultLayer.pipe(Layer.provide(Database.layerFromPath(dbPath))),
          ),
        ),
        Effect.scoped,
      ),
    )
    expect(result._tag).toBe("Failure")
  })

  // C1: the at-least-one-of rule is enforced at the SCHEMA level, so an empty
  // `{}` call fails decode before execute (previously it passed the schema and
  // only errored inside the handler — the model's first graph-tool call in the
  // chess benchmark died exactly there).
  test("schema rejects empty input at decode time with a clear message", () => {
    expect(() => Schema.decodeUnknownSync(RepoMapInput)({})).toThrow(
      "at least one of `root`, `path`, or `query` must be provided",
    )
    // root-only overview call still decodes fine.
    expect(Schema.decodeUnknownSync(RepoMapInput)({ root: "/repo" }).root).toBe("/repo")
    // path-only and query-only calls decode fine too.
    expect(Schema.decodeUnknownSync(RepoMapInput)({ path: "src/feature.ts" }).path).toBe("src/feature.ts")
    expect(Schema.decodeUnknownSync(RepoMapInput)({ query: "doWork" }).query).toBe("doWork")
  })
})

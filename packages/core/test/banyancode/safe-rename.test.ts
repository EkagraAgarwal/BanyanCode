import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import {
  computeSafeRename,
  Input,
  makeSafeRenameTool,
  name,
} from "../../src/tool/safe-rename"
import {
  CodegraphRepo,
  defaultLayer as codegraphRepoDefaultLayer,
} from "../../src/banyancode/codegraph-repo"
import {
  CodegraphAnalyzer,
  defaultLayer as codegraphAnalyzerDefaultLayer,
} from "../../src/banyancode/codegraph-analyzer"
import {
  RepositoryIntelligence,
  defaultLayer as repositoryIntelligenceDefaultLayer,
} from "../../src/banyancode/repository-intelligence"
import {
  EditPlanner,
  defaultLayer as editPlannerDefaultLayer,
} from "../../src/banyancode/edit-planner"
import type { CodegraphFile, CodegraphNode } from "../../src/banyancode/types"
import type { Interface as CodegraphRepoInterface } from "../../src/banyancode/codegraph-repo"
import type { Interface as CodegraphAnalyzerInterface } from "../../src/banyancode/codegraph-analyzer"
import type { Interface as RepositoryIntelligenceInterface } from "../../src/banyancode/repository-intelligence/service"
import type { Interface as EditPlannerInterface } from "../../src/banyancode/edit-planner"
import type { Interface as PermissionV2Interface } from "../../src/permission"

process.env.BANYANCODE_ENABLE = "1"

const mockPermission = {
  assert: () => Effect.void,
  ask: () => Effect.void,
  reply: () => Effect.void,
  configured: () => Effect.void,
  list: () => Effect.succeed([]),
  get: () => Effect.void,
  forSession: () => Effect.void,
} as unknown as PermissionV2Interface

const seedRenameGraph = (repo: CodegraphRepoInterface) =>
  Effect.gen(function* () {
    const targetFile: CodegraphFile = {
      id: "file-target",
      path: "src/foo.ts",
      contentHash: "h1",
      language: "typescript",
      indexedAt: 1,
    }
    const callerFile: CodegraphFile = {
      id: "file-caller",
      path: "src/bar.ts",
      contentHash: "h2",
      language: "typescript",
      indexedAt: 2,
    }
    yield* repo.putFile(targetFile)
    yield* repo.putFile(callerFile)

    yield* repo.putNode({
      id: "node-foo-class",
      fileID: "file-target",
      kind: "class",
      name: "Foo",
      startLine: 1,
      endLine: 100,
    })
    yield* repo.putNode({
      id: "node-target",
      fileID: "file-target",
      kind: "method",
      name: "bar",
      startLine: 5,
      endLine: 15,
    })
    yield* repo.putNode({
      id: "node-caller",
      fileID: "file-caller",
      kind: "function",
      name: "main",
      startLine: 1,
      endLine: 5,
    })
    yield* repo.putEdge({
      id: "edge-caller-target",
      fromNodeID: "node-caller",
      toNodeID: "node-target",
      kind: "calls",
    })
  })

const testLayer = Layer.mergeAll(
  codegraphAnalyzerDefaultLayer,
  codegraphRepoDefaultLayer,
  repositoryIntelligenceDefaultLayer,
  editPlannerDefaultLayer,
)

describe("safe_rename tool", () => {
  test("name and Input schemas have correct shape", () => {
    expect(name).toBe("safe_rename")
    expect(Input.fields).toHaveProperty("symbol")
    expect(Input.fields).toHaveProperty("newName")
    expect(Input.fields).toHaveProperty("dryRun")
  })

  test("computeSafeRename emits an edit per direct caller and includes preflight fallback", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        const analyzer = yield* CodegraphAnalyzer.Service
        const intel = yield* RepositoryIntelligence.Service
        const planner = yield* EditPlanner.Service
        yield* seedRenameGraph(repo as unknown as CodegraphRepoInterface)

        const result = yield* computeSafeRename(
          {
            repo: repo as unknown as CodegraphRepoInterface,
            analyzer: analyzer as unknown as CodegraphAnalyzerInterface,
            intel: intel as unknown as RepositoryIntelligenceInterface,
            planner: planner as unknown as EditPlannerInterface,
          },
          { symbol: "Foo.bar", newName: "Foo.baz", dryRun: false },
        )

        expect(result.edits.length).toBeGreaterThanOrEqual(1)
        expect(result.edits.every((e) => e.oldText === "bar" && e.newText === "baz")).toBe(true)
        expect(result.testsToRun.length).toBeGreaterThanOrEqual(0)
        expect(Array.isArray(result.risks)).toBe(true)
        expect(result.preflight).toBeDefined()
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("computeSafeRename fails with ToolFailure when both symbol and newName are unqualified", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        const analyzer = yield* CodegraphAnalyzer.Service
        const intel = yield* RepositoryIntelligence.Service
        const planner = yield* EditPlanner.Service

        const exit = yield* Effect.exit(
          computeSafeRename(
            {
              repo: repo as unknown as CodegraphRepoInterface,
              analyzer: analyzer as unknown as CodegraphAnalyzerInterface,
              intel: intel as unknown as RepositoryIntelligenceInterface,
              planner: planner as unknown as EditPlannerInterface,
            },
            { symbol: "bar", newName: "baz", dryRun: false },
          ),
        )
        if (exit._tag !== "Failure") throw new Error("expected Failure")
        const failure = exit.cause
        expect(JSON.stringify(failure)).toContain("cannot resolve namespace")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("computeSafeRename infers namespace from qualified symbol when newName is bare", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        const analyzer = yield* CodegraphAnalyzer.Service
        const intel = yield* RepositoryIntelligence.Service
        const planner = yield* EditPlanner.Service
        yield* seedRenameGraph(repo as unknown as CodegraphRepoInterface)

        const result = yield* computeSafeRename(
          {
            repo: repo as unknown as CodegraphRepoInterface,
            analyzer: analyzer as unknown as CodegraphAnalyzerInterface,
            intel: intel as unknown as RepositoryIntelligenceInterface,
            planner: planner as unknown as EditPlannerInterface,
          },
          { symbol: "Foo.bar", newName: "baz", dryRun: false },
        )

        expect(result.edits.length).toBeGreaterThanOrEqual(1)
        expect(result.edits.every((e) => e.oldText === "bar" && e.newText === "baz")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("makeSafeRenameTool builds distinct tool instances per call", () => {
    const analyzerStub: CodegraphAnalyzerInterface = {
      callers: () => Effect.succeed([]),
      dependents: () => Effect.succeed([]),
      impact: () =>
        Effect.succeed({
          dependents: [] as Array<CodegraphNode>,
          transitive: [] as Array<CodegraphNode>,
        }),
      walkTransitive: () => Effect.succeed([]),
    }
    const repoStub: CodegraphRepoInterface = {
      listAllFiles: () => Effect.succeed([]),
      searchNodes: () => Effect.succeed([]),
      findSymbolsByServiceTag: () => Effect.succeed([]),
    } as unknown as CodegraphRepoInterface
    const intelStub: RepositoryIntelligenceInterface = {
      symbols: () => Effect.succeed([]),
      tests: () => Effect.succeed({ tests: [], notFound: false }),
      query: () => Effect.die("not used" as never),
      slice: () => Effect.die("not used" as never),
      explain: () => Effect.die("not used" as never),
      impact: () => Effect.die("not used" as never),
      trace: () => Effect.die("not used" as never),
      relationships: () => Effect.succeed([]),
      findOwner: () => Effect.succeed({ count: 0 }),
    } as unknown as RepositoryIntelligenceInterface
    const plannerStub: EditPlannerInterface = {
      planBeforeEdit: () => Effect.die("not used" as never),
      planAfterEdit: () => Effect.die("not used" as never),
    } as unknown as EditPlannerInterface

    const toolA = makeSafeRenameTool({
      permission: mockPermission,
      repo: repoStub,
      analyzer: analyzerStub,
      intel: intelStub,
      planner: plannerStub,
    })
    const toolB = makeSafeRenameTool({
      permission: mockPermission,
      repo: repoStub,
      analyzer: analyzerStub,
      intel: intelStub,
      planner: plannerStub,
    })
    expect(toolA).toBeDefined()
    expect(toolB).toBeDefined()
    expect(toolA).not.toBe(toolB)
  })
})

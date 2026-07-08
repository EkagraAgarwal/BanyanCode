import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import {
  computePreflight,
  Input,
  makePreflightTool,
  name,
} from "../../src/tool/preflight"
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
import type { CodegraphFile, CodegraphNode } from "../../src/banyancode/types"
import type { Interface as CodegraphRepoInterface } from "../../src/banyancode/codegraph-repo"
import type { Interface as CodegraphAnalyzerInterface } from "../../src/banyancode/codegraph-analyzer"
import type { Interface as RepositoryIntelligenceInterface } from "../../src/banyancode/repository-intelligence/service"
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

const seedPreflightGraph = (repo: CodegraphRepoInterface) =>
  Effect.gen(function* () {
    const targetFile: CodegraphFile = {
      id: "file-target",
      path: "src/target.ts",
      contentHash: "h1",
      language: "typescript",
      indexedAt: 1,
    }
    const callerFile: CodegraphFile = {
      id: "file-caller",
      path: "src/caller.ts",
      contentHash: "h2",
      language: "typescript",
      indexedAt: 2,
    }
    const testFile: CodegraphFile = {
      id: "file-test",
      path: "src/target.test.ts",
      contentHash: "h3",
      language: "typescript",
      indexedAt: 3,
    }
    const docFile: CodegraphFile = {
      id: "file-doc",
      path: "design/foo.md",
      contentHash: "h4",
      language: "markdown",
      indexedAt: 4,
    }
    yield* repo.putFile(targetFile)
    yield* repo.putFile(callerFile)
    yield* repo.putFile(testFile)
    yield* repo.putFile(docFile)

    yield* repo.putNode({
      id: "node-target",
      fileID: "file-target",
      kind: "function",
      name: "alpha",
      startLine: 1,
      endLine: 10,
    })
    yield* repo.putNode({
      id: "node-caller",
      fileID: "file-caller",
      kind: "function",
      name: "useAlpha",
      startLine: 1,
      endLine: 5,
    })
    yield* repo.putNode({
      id: "node-test",
      fileID: "file-test",
      kind: "test",
      name: "alphaTest",
      startLine: 1,
      endLine: 5,
      code: `import { alpha } from "./target"\ndescribe("alpha", () => it("works", () => {}))`,
    })
    yield* repo.putNode({
      id: "node-doc",
      fileID: "file-doc",
      kind: "doc",
      name: "alphaDesign",
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
)

describe("preflight tool", () => {
  test("name and Input schemas have correct shape", () => {
    expect(name).toBe("preflight")
    expect(Input.fields).toHaveProperty("action")
    expect(Input.fields).toHaveProperty("target")
    expect(Input.fields).toHaveProperty("depth")
  })

  test("computePreflight resolves target, lists directCaller and detects no-target risk for missing symbol", async () => {
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
        yield* seedPreflightGraph(repo as unknown as CodegraphRepoInterface)

        const found = yield* computePreflight(
          {
            repo: repo as unknown as CodegraphRepoInterface,
            analyzer: analyzer as unknown as CodegraphAnalyzerInterface,
            intel: intel as unknown as RepositoryIntelligenceInterface,
          },
          { action: "rename", target: "alpha" },
        )

        expect(found.target.resolved).toBe(true)
        expect(found.target.node?.name).toBe("alpha")
        expect(found.directCallers.length).toBeGreaterThanOrEqual(1)
        expect(found.derivation).toBe("regex-v1")
        expect(typeof found.generatedAt).toBe("number")

        const missing = yield* computePreflight(
          {
            repo: repo as unknown as CodegraphRepoInterface,
            analyzer: analyzer as unknown as CodegraphAnalyzerInterface,
            intel: intel as unknown as RepositoryIntelligenceInterface,
          },
          { action: "modify", target: "totallyMissing_xyz123" },
        )

        expect(missing.target.resolved).toBe(false)
        const noTargetRisk = missing.risks.find((r) => r.kind === "no-target")
        expect(noTargetRisk?.severity).toBe("high")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("makePreflightTool builds a tool with type-safe deps and produces distinct instances", async () => {
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

    const toolA = makePreflightTool({
      permission: mockPermission,
      repo: repoStub,
      analyzer: analyzerStub,
      intel: intelStub,
    })
    const toolB = makePreflightTool({
      permission: mockPermission,
      repo: repoStub,
      analyzer: analyzerStub,
      intel: intelStub,
    })
    expect(toolA).toBeDefined()
    expect(toolB).toBeDefined()
    expect(toolA).not.toBe(toolB)
  })
})

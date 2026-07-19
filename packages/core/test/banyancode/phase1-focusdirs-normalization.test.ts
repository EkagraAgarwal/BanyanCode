import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import {
  RepositoryIntelligence,
  defaultLayer as repositoryIntelligenceDefaultLayer,
} from "../../src/banyancode/repository-intelligence"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(
  repositoryIntelligenceDefaultLayer,
  CodegraphRepo.defaultLayer,
)

// Plan Phase 1.1: focusDirs must be normalized against the indexed root so
// the caller can pass either graph-relative prefixes (`packages/opencode`)
// or full Windows-style paths that include the worktree (`D:\repo\...`).
const setRoot = (db: { db: unknown }, indexedRoot: string) =>
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service
    yield* repo.setMeta({
      id: "singleton",
      graphBuiltAt: 1,
      graphVersion: 1,
      graphCoverage: 1,
      totalFiles: 1,
      totalNodes: 1,
      totalEdges: 0,
      schemaVersion: 1,
      indexedRoot,
    })
  })

describe("Phase 1.1: focusDirs normalization against indexed_root", () => {
  test("caller-supplied focusDirs containing the indexed root resolve correctly", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const indexedRoot = path.join(tmp.path, "repo")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "f-opencode",
          path: "packages/opencode/src/tool.ts",
          contentHash: "h1",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putFile({
          id: "f-web",
          path: "packages/web/src/tool.tsx",
          contentHash: "h2",
          language: "tsx",
          indexedAt: 2,
        })
        yield* repo.putNode({
          id: "n-opencode",
          fileID: "f-opencode",
          kind: "function",
          name: "SharedTool",
          signature: "function SharedTool()",
          startLine: 1,
          endLine: 5,
        })
        yield* repo.putNode({
          id: "n-web",
          fileID: "f-web",
          kind: "function",
          name: "SharedTool",
          signature: "function SharedTool()",
          startLine: 1,
          endLine: 5,
        })
        yield* setRoot({ db }, indexedRoot)

        const ri = yield* RepositoryIntelligence.Service
        const fullPrefix = path.join(indexedRoot, "packages", "opencode")
        const result = yield* ri.query({
          query: "SharedTool",
          workspace: { worktree: indexedRoot, focusDirs: [fullPrefix] },
        })

        expect(result.status).toBe("success")
        expect(result.symbols.length).toBe(1)
        expect(result.symbols[0]!.id).toBe("n-opencode")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("backslashes in focusDirs are normalized to forward slashes", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "f-opencode",
          path: "packages/opencode/src/tool.ts",
          contentHash: "h1",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putNode({
          id: "n-opencode",
          fileID: "f-opencode",
          kind: "function",
          name: "BackslashTool",
          signature: "function BackslashTool()",
          startLine: 1,
          endLine: 5,
        })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.query({
          query: "BackslashTool",
          workspace: { worktree: "/fake", focusDirs: ["packages\\opencode"] },
        })

        expect(result.status).toBe("success")
        expect(result.symbols.length).toBe(1)
        expect(result.symbols[0]!.id).toBe("n-opencode")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("empty focusDirs array behaves like unscoped (no filtering)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "f-opencode",
          path: "packages/opencode/src/tool.ts",
          contentHash: "h1",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putFile({
          id: "f-core",
          path: "packages/core/src/tool.ts",
          contentHash: "h2",
          language: "typescript",
          indexedAt: 2,
        })
        yield* repo.putNode({
          id: "n-opencode",
          fileID: "f-opencode",
          kind: "function",
          name: "DualTool",
          signature: "function DualTool()",
          startLine: 1,
          endLine: 5,
        })
        yield* repo.putNode({
          id: "n-core",
          fileID: "f-core",
          kind: "function",
          name: "DualTool",
          signature: "function DualTool()",
          startLine: 1,
          endLine: 5,
        })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.query({
          query: "DualTool",
          workspace: { worktree: "/fake", focusDirs: [] },
        })

        const ids = result.symbols.map((n) => n.id).sort()
        expect(ids).toEqual(["n-core", "n-opencode"])
        expect(result.ambiguity).toEqual({ total: 2, kept: 2 })
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
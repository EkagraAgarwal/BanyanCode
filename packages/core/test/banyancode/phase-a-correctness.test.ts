import { describe, expect, spyOn, test } from "bun:test"
import { Effect, Exit, Layer, Queue } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import {
  CodegraphIndexer,
  defaultLayer as codegraphIndexerDefaultLayer,
} from "../../src/banyancode/codegraph-indexer"
import {
  RepositoryIntelligence,
  defaultLayer as repositoryIntelligenceDefaultLayer,
} from "../../src/banyancode/repository-intelligence"
import { tmpdir } from "../fixture/tmpdir"
import * as fs from "node:fs/promises"
import * as path from "node:path"

process.env.BANYANCODE_ENABLE = "1"

const repositoryTestLayer = Layer.mergeAll(
  repositoryIntelligenceDefaultLayer,
  CodegraphRepo.defaultLayer,
)

const indexerTestLayer = Layer.mergeAll(
  codegraphIndexerDefaultLayer,
  CodegraphRepo.defaultLayer,
).pipe(Layer.provide(FSUtil.defaultLayer))

describe("Phase A correctness", () => {
  test("impact traverses nodes from the exact file instead of basename matches", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "impact.db"))

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "file-target",
          path: "packages/core/src/banyancode/codegraph-indexer.ts",
          contentHash: "target",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putFile({
          id: "file-basename-match",
          path: "src/runtime/codegraph-indexer.ts",
          contentHash: "other",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putFile({
          id: "file-target-caller",
          path: "src/build-target.ts",
          contentHash: "caller",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putFile({
          id: "file-target-dependency",
          path: "src/target-dependency.ts",
          contentHash: "dependency",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putFile({
          id: "file-other-caller",
          path: "src/build-other.ts",
          contentHash: "other-caller",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putFile({
          id: "file-other-dependency",
          path: "src/other-dependency.ts",
          contentHash: "other-dependency",
          language: "typescript",
          indexedAt: 1,
        })

        yield* repo.putNodes([
          {
            id: "node-target-indexed-file",
            fileID: "file-target",
            kind: "class",
            name: "IndexedFile",
            signature: "class IndexedFile",
            startLine: 1,
            endLine: 5,
          },
          {
            id: "node-basename-indexed-file",
            fileID: "file-basename-match",
            kind: "class",
            name: "IndexedFile",
            signature: "class IndexedFile",
            startLine: 1,
            endLine: 5,
          },
          {
            id: "node-target-caller",
            fileID: "file-target-caller",
            kind: "function",
            name: "buildTargetIndex",
            signature: "buildTargetIndex()",
            startLine: 1,
            endLine: 5,
          },
          {
            id: "node-target-dependency",
            fileID: "file-target-dependency",
            kind: "class",
            name: "TargetDependency",
            signature: "class TargetDependency",
            startLine: 1,
            endLine: 5,
          },
          {
            id: "node-other-caller",
            fileID: "file-other-caller",
            kind: "function",
            name: "buildOtherIndex",
            signature: "buildOtherIndex()",
            startLine: 1,
            endLine: 5,
          },
          {
            id: "node-other-dependency",
            fileID: "file-other-dependency",
            kind: "class",
            name: "OtherDependency",
            signature: "class OtherDependency",
            startLine: 1,
            endLine: 5,
          },
        ])
        yield* repo.putEdges([
          {
            id: "edge-target-caller",
            fromNodeID: "node-target-caller",
            toNodeID: "node-target-indexed-file",
            kind: "calls",
          },
          {
            id: "edge-target-dependency",
            fromNodeID: "node-target-indexed-file",
            toNodeID: "node-target-dependency",
            kind: "imports",
          },
          {
            id: "edge-other-caller",
            fromNodeID: "node-other-caller",
            toNodeID: "node-basename-indexed-file",
            kind: "calls",
          },
          {
            id: "edge-other-dependency",
            fromNodeID: "node-basename-indexed-file",
            toNodeID: "node-other-dependency",
            kind: "imports",
          },
        ])

        const intelligence = yield* RepositoryIntelligence.Service
        const result = yield* intelligence.impact({
          path: "packages/core/src/banyancode/codegraph-indexer.ts",
        })
        const visibleNodeIDs = new Set([
          ...result.importantSymbols,
          ...result.directCallers,
          ...result.transitiveDependents,
        ].map((node) => node.id))

        expect(visibleNodeIDs.has("node-target-indexed-file")).toBe(true)
        expect(visibleNodeIDs.has("node-target-caller")).toBe(true)
        expect(visibleNodeIDs.has("node-basename-indexed-file")).toBe(false)
        expect(visibleNodeIDs.has("node-other-caller")).toBe(false)
        expect(result.directCallers.map((node) => node.id)).toContain("node-target-caller")
        expect(result.dependencies.map((dependency) => dependency.name)).toContain("TargetDependency")
        expect(result.dependencies.map((dependency) => dependency.name)).not.toContain("OtherDependency")
      }).pipe(Effect.provide(repositoryTestLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("query batches final edge collection for 100 symbols", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "query.db"))

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* repo.putFile({
          id: "file-symbols",
          path: "src/shared-symbols.ts",
          contentHash: "symbols",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putNodes(
          Array.from({ length: 25 }, (_, index) => ({
            id: `node-${index}`,
            fileID: "file-symbols",
            kind: "function" as const,
            name: "SharedSymbol",
            signature: `SharedSymbol${index}()`,
            startLine: index + 1,
            endLine: index + 1,
          })),
        )

        const directFrom = spyOn(repo, "edgesFrom")
        const directTo = spyOn(repo, "edgesTo")
        const batchFrom = spyOn(repo, "edgesFromBatch")
        const batchTo = spyOn(repo, "edgesToBatch")
        try {
          const intelligence = yield* RepositoryIntelligence.Service
          const result = yield* intelligence.query({ query: "SharedSymbol" })

          expect(result.symbols).toHaveLength(25)
          expect(result.graph.nodes.length).toBeGreaterThan(0)
          expect(directFrom).toHaveBeenCalledTimes(0)
          expect(directTo).toHaveBeenCalledTimes(0)
          expect(batchFrom.mock.calls.filter(([ids]) => ids.length === 25)).toHaveLength(1)
          expect(batchTo.mock.calls.filter(([ids]) => ids.length === 25)).toHaveLength(1)
        } finally {
          directFrom.mockRestore()
          directTo.mockRestore()
          batchFrom.mockRestore()
          batchTo.mockRestore()
        }
      }).pipe(Effect.provide(repositoryTestLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("indexFiles resets cancellation before indexing", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "cancel.db"))
    const worktree = path.join(tmp.path, "repo")
    const target = path.join(worktree, "target.ts")
    await fs.mkdir(worktree, { recursive: true })
    await fs.writeFile(target, "export function target() { return 1 }\n")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const indexer = yield* CodegraphIndexer.Service
        yield* indexer.cancel()

        const result = yield* indexer.indexFiles({ root: worktree, paths: [target] })
        const repo = yield* CodegraphRepo.Service
        const indexedFile = yield* repo.getFileByPath(target)

        expect(result.indexed).toBe(1)
        expect(indexedFile).toBeDefined()
      }).pipe(Effect.provide(indexerTestLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("indexFiles shuts down its parsed queue after producer failure", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "shutdown.db"))
    const worktree = path.join(tmp.path, "repo")
    const target = path.join(worktree, "target.ts")
    await fs.mkdir(worktree, { recursive: true })
    await fs.writeFile(target, "export function target() { return 1 }\n")

    const shutdown = spyOn(Queue, "shutdown")
    try {
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
          const indexer = yield* CodegraphIndexer.Service
          let progressCalls = 0
          return yield* indexer.indexFiles({
            root: worktree,
            paths: [target],
            onProgress: () =>
              Effect.sync(() => {
                progressCalls++
                if (progressCalls > 1) throw new Error("producer-failure")
              }),
          }).pipe(Effect.exit)
        }).pipe(Effect.provide(indexerTestLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(shutdown).toHaveBeenCalledTimes(1)
    } finally {
      shutdown.mockRestore()
    }
  }, 30_000)
})

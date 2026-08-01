import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { CodegraphAnalyzer, defaultLayer as codegraphAnalyzerDefaultLayer } from "../../src/banyancode/codegraph-analyzer"
import type { CodegraphFile, CodegraphNode } from "../../src/banyancode/types"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const seedGraph = (repo: CodegraphRepo.Interface) =>
  Effect.gen(function* () {
    const fileA: CodegraphFile = {
      id: "file-target",
      path: "src/banyancode/codegraph-repo.ts",
      contentHash: "h-a",
      language: "typescript",
      indexedAt: 1,
    }
    const fileB: CodegraphFile = {
      id: "file-caller",
      path: "src/handlers/graph-handler.ts",
      contentHash: "h-b",
      language: "typescript",
      indexedAt: 2,
    }
    const fileC: CodegraphFile = {
      id: "file-other-caller",
      path: "src/services/builder.ts",
      contentHash: "h-c",
      language: "typescript",
      indexedAt: 3,
    }
    yield* repo.putFile(fileA)
    yield* repo.putFile(fileB)
    yield* repo.putFile(fileC)

    // Symbol-level node inside the target file — must be discovered by the
    // file-level impact aggregation.
    yield* repo.putNode({
      id: "sym-bumpversion",
      fileID: "file-target",
      kind: "method",
      name: "bumpVersion",
      startLine: 10,
      endLine: 20,
    })

    // Callers in two other files.
    yield* repo.putNode({
      id: "sym-handler",
      fileID: "file-caller",
      kind: "function",
      name: "handleGraph",
      startLine: 1,
      endLine: 5,
    })
    yield* repo.putNode({
      id: "sym-builder",
      fileID: "file-other-caller",
      kind: "function",
      name: "buildAll",
      startLine: 1,
      endLine: 5,
    })

    yield* repo.putEdge({
      id: "e-handler-bv",
      fromNodeID: "sym-handler",
      toNodeID: "sym-bumpversion",
      kind: "calls",
    })
    yield* repo.putEdge({
      id: "e-builder-bv",
      fromNodeID: "sym-builder",
      toNodeID: "sym-bumpversion",
      kind: "calls",
    })
  })

const testLayer = Layer.mergeAll(codegraphAnalyzerDefaultLayer, codegraphRepoDefaultLayer)

describe("code_find intent=impact — file-level aggregation", () => {
  test("filename-shaped target returns callers aggregated across all symbols in the file", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const tag = yield* CodegraphRepo.Service
        const repo = tag as unknown as CodegraphRepo.Interface
        const analyzer = yield* CodegraphAnalyzer.Service
        yield* seedGraph(repo)

        // Mimic the production intent=impact branch's file-level detection.
        const target = "codegraph-repo.ts"
        const looksLikeFilePath = /\.[a-z0-9]+$/i.test(target) || /[\\/]/.test(target)
        expect(looksLikeFilePath).toBe(true)

        const allFiles = yield* repo.listAllFiles()
        const allNodes = yield* repo.listAllNodes()
        const sep = /[\\/]/.test(target) ? `[\\${"/"}]` : ""
        const fileHits = allFiles.filter((f) => f.path.endsWith(`${sep}${target}`))
        const fileIDs = new Set(fileHits.map((f) => f.id))
        const symbolNodes = allNodes.filter(
          (n) => fileIDs.has(n.fileID) && n.kind !== "file",
        )

        // The target file holds one symbol; aggregation should reach both
        // callers via analyzer.impact.
        expect(fileHits.length).toBe(1)
        expect(symbolNodes.length).toBe(1)
        expect(symbolNodes[0]?.name).toBe("bumpVersion")

        const seen = new Set<string>()
        const dependents: CodegraphNode[] = []
        const transitive: CodegraphNode[] = []
        for (const sym of symbolNodes) {
          const r = yield* analyzer.impact({ nodeID: sym.id }).pipe(
            Effect.matchEffect({
              onFailure: () =>
                Effect.succeed<{ dependents: CodegraphNode[]; transitive: CodegraphNode[] }>({
                  dependents: [],
                  transitive: [],
                }),
              onSuccess: (i) => Effect.succeed(i),
            }),
          )
          for (const n of [...r.dependents, ...r.transitive]) {
            if (!seen.has(n.id)) {
              seen.add(n.id)
              dependents.push(n)
            }
          }
        }

        expect(dependents.length).toBe(2)
        const names = dependents.map((d) => d.name).sort()
        expect(names).toEqual(["buildAll", "handleGraph"])
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("filename-shaped target with no matching file returns target-not-resolved equivalent", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const tag = yield* CodegraphRepo.Service
        const repo = tag as unknown as CodegraphRepo.Interface
        yield* seedGraph(repo)

        const target = "nonexistent-file.ts"
        const allFiles = yield* repo.listAllFiles()
        const fileHits = allFiles.filter((f) => f.path.endsWith(`/${target}`))
        expect(fileHits.length).toBe(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
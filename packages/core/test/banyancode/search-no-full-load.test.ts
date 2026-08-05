import { describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { Search, defaultLayer as SearchLayer } from "../../src/banyancode/search/index"
import { resolveGraphTargetPure } from "../../src/banyancode/symbol-resolver"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

const seedFixture = () =>
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service
    yield* repo.putFile({
      id: "file-a",
      path: "src/build-service.ts",
      contentHash: "hash1",
      language: "typescript",
      indexedAt: 1,
    })
    yield* repo.putNode({
      id: "node-build-service",
      fileID: "file-a",
      kind: "function",
      name: "buildService",
      signature: "buildService(root: string)",
      startLine: 1,
      endLine: 20,
      code: "function buildService(root: string) {}",
    })
    yield* repo.putNode({
      id: "node-other",
      fileID: "file-a",
      kind: "function",
      name: "otherThing",
      signature: "otherThing()",
      startLine: 22,
      endLine: 25,
      code: "function otherThing() {}",
    })
  })

describe("Phase 2 (P4/P5): no full-graph loads in the hot paths", () => {
  test("search() cascade never calls repo.listAllEdges", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const repo = yield* CodegraphRepo.Service

        const edgesSpy = spyOn(repo, "listAllEdges")
        const allNodesSpy = spyOn(repo, "listAllNodes")
        try {
          const search = yield* Search.Service
          const results = yield* search.search("buildService", { mode: "auto" })
          expect(results.length).toBeGreaterThan(0)
          expect(edgesSpy).toHaveBeenCalledTimes(0)
          expect(allNodesSpy).toHaveBeenCalledTimes(0)
        } finally {
          edgesSpy.mockRestore()
          allNodesSpy.mockRestore()
        }
      }).pipe(
        Effect.provide(SearchLayer),
        Effect.provide(CodegraphRepo.defaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("symbol-resolver code-substring fallback never calls repo.listAllNodes on a miss", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const repo = yield* CodegraphRepo.Service

        const allNodesSpy = spyOn(repo, "listAllNodes")
        try {
          // Steps 1-3 miss (no tag, no exact name, no dot), so the
          // code-substring (step 4) and name-like (step 5) fallbacks run.
          // Both must stay bounded: searchNodesLight + nodesByIDs for the
          // code scan, searchNodes for the LIKE — never listAllNodes.
          const result = yield* resolveGraphTargetPure(repo, { target: "zzz-no-such-symbol-xyz" })
          expect(result._tag).toBe("Miss")
          expect(allNodesSpy).toHaveBeenCalledTimes(0)
        } finally {
          allNodesSpy.mockRestore()
        }
      }).pipe(
        Effect.provide(CodegraphRepo.defaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("symbol-resolver qualified-split path never calls repo.listAllNodes", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const repo = yield* CodegraphRepo.Service

        const allNodesSpy = spyOn(repo, "listAllNodes")
        try {
          // `buildService.nonexistent` has a dot → step 3 (qualified-split)
          // runs and computes the parent-file scope from a light projection;
          // the missing leaf then falls through to the bounded step-4/step-5
          // fallbacks. None of them may load the full nodes table.
          const result = yield* resolveGraphTargetPure(repo, { target: "buildService.nonexistent" })
          expect(result._tag).toBe("Miss")
          expect(allNodesSpy).toHaveBeenCalledTimes(0)
        } finally {
          allNodesSpy.mockRestore()
        }
      }).pipe(
        Effect.provide(CodegraphRepo.defaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })
})

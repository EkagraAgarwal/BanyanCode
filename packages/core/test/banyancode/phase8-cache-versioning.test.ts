import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { TraceCollector, defaultLayer as traceCollectorDefaultLayer } from "../../src/banyancode/trace-collector"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(traceCollectorDefaultLayer, CodegraphRepo.defaultLayer)

describe("Phase 8: cache versioning", () => {
  test("resolveName cache invalidates when graphVersion bumps", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f1", path: "src/util.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({
          id: "n-old",
          fileID: "f1",
          kind: "function",
          name: "myFn",
          signature: "function myFn()",
          startLine: 1,
          endLine: 5,
          code: "function myFn() {}",
        })
        yield* repo.setMeta({
          id: "singleton",
          graphBuiltAt: 1,
          graphVersion: 1,
          graphCoverage: 1,
          totalFiles: 1,
          totalNodes: 1,
          totalEdges: 0,
          schemaVersion: 1,
        })

        const collector = yield* TraceCollector.Service
        yield* collector.record({ traceName: "myFn", parentTraceName: null, observedAt: 1 })
        yield* collector.record({ traceName: "myFn", parentTraceName: null, observedAt: 2 })
        const callersBefore = yield* collector.observedCallers({ nodeID: "n-old" })
        expect(callersBefore).toHaveLength(0)

        yield* repo.deleteFile("f1")
        yield* repo.putFile({ id: "f1", path: "src/util.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })
        yield* repo.putNode({
          id: "n-new",
          fileID: "f1",
          kind: "function",
          name: "myFn",
          signature: "function myFn()",
          startLine: 1,
          endLine: 5,
          code: "function myFn() {}",
        })
        yield* repo.setMeta({
          id: "singleton",
          graphBuiltAt: 2,
          graphVersion: 2,
          graphCoverage: 1,
          totalFiles: 1,
          totalNodes: 1,
          totalEdges: 0,
          schemaVersion: 1,
        })

        yield* collector.record({ traceName: "myFn", parentTraceName: null, observedAt: 3 })
        const callersAfter = yield* collector.observedCallers({ nodeID: "n-new" })
        expect(callersAfter).toHaveLength(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

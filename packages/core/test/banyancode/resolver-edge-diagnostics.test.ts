import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { RepositoryIntelligence, defaultLayer as repositoryIntelligenceDefaultLayer } from "../../src/banyancode/repository-intelligence"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

// Phase 7 follow-up: source-vs-test caller separation and the new
// diagnostic states for repository-intelligence tools. Per the plan:
//   - source-intent fields (directCallers, transitiveDependents) must
//     exclude test-file callers, while relatedTests retains them
//   - explicit diagnostic states for target-not-resolved,
//     graph-out-of-scope, no-source-callers, no-edges-found must
//     never collapse into a single "unused" conclusion

const seedSourceAndTestFixture = () =>
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service

    // Source-caller and test-caller both reference the target.
    yield* repo.putFile({ id: "f-target", path: "src/target.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
    yield* repo.putFile({ id: "f-source", path: "src/source-caller.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
    yield* repo.putFile({ id: "f-test", path: "test/target.test.ts", contentHash: "h", language: "typescript", indexedAt: 1 })

    yield* repo.putNode({
      id: "n-target",
      fileID: "f-target",
      kind: "function",
      name: "target",
      signature: "target()",
      startLine: 1,
      endLine: 2,
      code: "function target() {}",
    })
    yield* repo.putNode({
      id: "n-source",
      fileID: "f-source",
      kind: "function",
      name: "sourceCaller",
      signature: "sourceCaller()",
      startLine: 1,
      endLine: 2,
      code: "function sourceCaller() {}",
    })
    yield* repo.putNode({
      id: "n-test",
      fileID: "f-test",
      kind: "function",
      name: "testCaller",
      signature: "testCaller()",
      startLine: 1,
      endLine: 2,
      code: "function testCaller() {}",
    })

    yield* repo.putEdge({ id: "e-source-target", fromNodeID: "n-source", toNodeID: "n-target", kind: "calls" })
    yield* repo.putEdge({ id: "e-test-target", fromNodeID: "n-test", toNodeID: "n-target", kind: "calls" })
  })

const seedNoCallersFixture = () =>
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service
    yield* repo.putFile({ id: "f-orphan", path: "src/orphan.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
    yield* repo.putNode({
      id: "n-orphan",
      fileID: "f-orphan",
      kind: "function",
      name: "orphan",
      signature: "orphan()",
      startLine: 1,
      endLine: 2,
      code: "function orphan() {}",
    })
  })

const testLayer = Layer.mergeAll(repositoryIntelligenceDefaultLayer, CodegraphRepo.defaultLayer)

describe("Resolver edge diagnostics", () => {
  test("trace separates source callers from test callers — source intent excludes test", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedSourceAndTestFixture()
        const ri = yield* RepositoryIntelligence.Service

        const slc = yield* ri.trace({ symbol: "target", depth: 2 })

        // Source-intent: directCallers must include the source caller
        // but NOT the test caller. The test caller is preserved in
        // relatedTests, which is the explicit field for tests.
        const direct = slc.directCallers.map((n) => n.name).sort()
        expect(direct).toContain("sourceCaller")
        expect(direct).not.toContain("testCaller")

        // relatedTests retains the test caller so the user can still
        // see it under the explicit "tests" grouping.
        const testNames = slc.relatedTests.map((n) => n.name).sort()
        expect(testNames).toContain("testCaller")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("trace for symbol with no callers surfaces empty directCallers with a reason", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedNoCallersFixture()
        const ri = yield* RepositoryIntelligence.Service

        const slc = yield* ri.trace({ symbol: "orphan", depth: 2 })

        // Per Phase 7 follow-up: zero callers must NOT be reported as
        // "unused" without a fresh, in-scope graph. The slice must
        // carry an explicit reason so the caller can distinguish
        // "no callers" from "no graph" or "out of scope".
        expect(slc.directCallers.length).toBe(0)
        expect(slc.transitiveDependents.length).toBe(0)
        expect(slc.summary).toBeDefined()
        // The new diagnostics field surfaces the explicit "no-edges-found"
        // state instead of leaving the caller to infer it from the empty
        // arrays.
        expect(slc.diagnostics).toBeDefined()
        const kinds = (slc.diagnostics ?? []).map((d) => d.kind)
        expect(kinds).toContain("no-edges-found")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("trace for an unknown symbol returns a degraded slice with a clear reason", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const ri = yield* RepositoryIntelligence.Service

        const slc = yield* ri.trace({ symbol: "definitely-not-in-graph", depth: 2 })

        // The unactionable "unused" conclusion must never be the
        // result of a legitimate "no symbol in graph" miss. The
        // status reports `failed` with a reason.
        expect(slc.status).toBe("failed")
        expect(slc.reason).toBeDefined()
        expect(typeof slc.reason).toBe("string")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { RepositoryIntelligence, defaultLayer as repositoryIntelligenceDefaultLayer } from "../../src/banyancode/repository-intelligence"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(
  repositoryIntelligenceDefaultLayer,
  CodegraphRepo.defaultLayer,
)

describe("RepositoryIntelligence Strict Diagnostic Policy", () => {
  test("repository_query with non-existent symbol returns failed + diagnostic", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-1", path: "src/math.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.query({ query: "DoesNotExist" })

        expect(result.status).toBe("failed")
        expect(result.diagnostics).toBeDefined()
        expect(result.diagnostics!.length).toBeGreaterThan(0)
        expect(result.diagnostics![0]!.kind).toBe("symbol-not-found")
        expect(result.fallbackUsed).toBe(false)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("repository_explain with Context.Service tag-recovered symbol returns success + fallbackUsed=true", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-tag", path: "src/memory-repo.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({
          id: "svc-memoryrepo",
          fileID: "file-tag",
          kind: "class",
          name: "Service",
          signature: "class Service extends Context.Service<Service, Interface>()",
          startLine: 1,
          endLine: 10,
          code: `export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Banyan/MemoryRepo") {}`,
        })

        const ri = yield* RepositoryIntelligence.Service
        const ctx = yield* ri.query({ query: "MemoryRepo" })

        expect(ctx.status).toBe("success")
        expect(ctx.fallbackUsed).toBe(true)
        expect(ctx.symbols.length).toBe(1)
        expect(ctx.symbols[0]!.name).toBe("Service")
        expect(ctx.diagnostics).toEqual([])
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("explain recovers realistic @opencode/v2/Banyan/MemoryRepo tag via substring + class filter", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-real", path: "src/memory-repo.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({
          id: "svc-real",
          fileID: "file-real",
          kind: "class",
          name: "Service",
          signature: "class Service extends Context.Service<Service, Interface>()",
          startLine: 1,
          endLine: 10,
          code: `class Service extends Context.Service<Service, Interface>()("@opencode/v2/Banyan/MemoryRepo")`,
        })

        const ri = yield* RepositoryIntelligence.Service
        const slc = yield* ri.explain({ symbol: "MemoryRepo" })

        expect(slc.status).toBe("success")
        expect(slc.fallbackUsed).toBe(true)
        expect(slc.importantSymbols.length).toBe(1)
        expect(slc.importantSymbols[0]!.name).toBe("Service")
        expect(slc.importantSymbols[0]!.kind).toBe("class")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("query for an Effect API string used inside a function body resolves to that function (code-substring derivation)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-doc", path: "docs/effect-module.md", contentHash: "h1", language: "markdown", indexedAt: 1 })
        yield* repo.putNode({
          id: "node-doc",
          fileID: "file-doc",
          kind: "doc",
          name: "EffectModule",
          signature: undefined,
          startLine: 1,
          endLine: 10,
          code: `# Effect.gen\nA markdown heading that mentions the substring…`,
        })

        yield* repo.putFile({ id: "file-utils", path: "src/baz-utils.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })
        yield* repo.putNode({
          id: "node-utils",
          fileID: "file-utils",
          kind: "class",
          name: "BazUtils",
          signature: "class BazUtils",
          startLine: 1,
          endLine: 10,
          code: `class BazUtils { method() { return "Effect.gen" } }`,
        })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.query({ query: "Effect.gen" })

        // The shared resolver's code-substring fallthrough intentionally surfaces
        // a class whose code references the queried string. This is the same
        // derivation code_find uses for "definitions", so tools agree.
        expect(result.status).toBe("success")
        expect(result.symbols.length).toBeGreaterThan(0)
        expect(result.symbols.find((n) => n.id === "node-utils")).toBeDefined()
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("repository_tests does not return substring noise", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-1", path: "src/real.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "file-test", path: "test/test_one.test.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })
        yield* repo.putFile({ id: "file-test2", path: "test/test_two.test.ts", contentHash: "h3", language: "typescript", indexedAt: 3 })
        yield* repo.putFile({ id: "file-test3", path: "test/test_three.test.ts", contentHash: "h4", language: "typescript", indexedAt: 4 })
        yield* repo.putFile({ id: "file-test4", path: "test/test_four.test.ts", contentHash: "h5", language: "typescript", indexedAt: 5 })
        yield* repo.putFile({ id: "file-test5", path: "test/test_five.test.ts", contentHash: "h6", language: "typescript", indexedAt: 6 })

        yield* repo.putNode({ id: "node-1", fileID: "file-1", kind: "class", name: "RealClass", signature: "class RealClass", startLine: 1, endLine: 10, code: "class RealClass {}" })
        yield* repo.putNode({ id: "test-1", fileID: "file-test", kind: "function", name: "test_one", signature: "test_one()", startLine: 1, endLine: 10, code: "function test_one() {}" })
        yield* repo.putNode({ id: "test-2", fileID: "file-test2", kind: "function", name: "test_two", signature: "test_two()", startLine: 1, endLine: 10, code: "function test_two() {}" })
        yield* repo.putNode({ id: "test-3", fileID: "file-test3", kind: "function", name: "test_three", signature: "test_three()", startLine: 1, endLine: 10, code: "function test_three() {}" })
        yield* repo.putNode({ id: "test-4", fileID: "file-test4", kind: "function", name: "test_four", signature: "test_four()", startLine: 1, endLine: 10, code: "function test_four() {}" })
        yield* repo.putNode({ id: "test-5", fileID: "file-test5", kind: "function", name: "test_five", signature: "test_five()", startLine: 1, endLine: 10, code: "function test_five() {}" })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.tests({ symbol: "DoesNotExist" })

        expect(result.tests.length).toBe(0)
        expect(result.notFound).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  // Regression for Issue #4: after the qualified-split widens to consult
  // service tags (Phase 1) AND the depth-1 bucket is dropped here (Phase 4),
  // `repository_tests` for a `Service`-shaped symbol resolves to the right
  // file and surfaces the test nodes that reference the leaf method.
  test("repository_tests returns ≥1 test for a Service-shaped symbol after Phase 1 resolver widening", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        // Production-like shape: Service class extends Context.Service<MemoRepo>()
        // ("…/MemoryRepo"); the actual `update` method is a sibling in the
        // same file. A separate test file references it via name. Phase 1
        // extracts the service_tag from the class `code` field; Phase 4
        // drops the depth-1 file bucket so the test in fMemTest shows up.
        yield* repo.writeFileGraph({
          file: {
            id: "fMem",
            path: "src/banyancode/memory-repo.ts",
            contentHash: "h",
            language: "typescript",
            indexedAt: 1,
          },
          nodes: [
            {
              id: "fMem:file",
              fileID: "fMem",
              kind: "file",
              name: "memory-repo.ts",
              startLine: 1,
              endLine: 1,
            },
            {
              id: "fMem:Service",
              fileID: "fMem",
              kind: "class",
              name: "Service",
              startLine: 1,
              endLine: 5,
              code: 'export class Service extends Context.Service<Interface>()("@opencode/v2/Banyan/MemoryRepo") {}',
            },
            {
              id: "fMem:update",
              fileID: "fMem",
              kind: "function",
              name: "update",
              startLine: 7,
              endLine: 20,
              code: "const update: Interface['update'] = (input) => { /* … */ }",
            },
          ],
          edges: [],
        })
        yield* repo.writeFileGraph({
          file: {
            id: "fMemTest",
            path: "test/memory-repo.test.ts",
            contentHash: "h",
            language: "typescript",
            indexedAt: 2,
          },
          nodes: [
            {
              id: "fMemTest:file",
              fileID: "fMemTest",
              kind: "file",
              name: "memory-repo.test.ts",
              startLine: 1,
              endLine: 1,
            },
            {
              id: "fMemTest:case",
              fileID: "fMemTest",
              kind: "function",
              name: "memoryRepoUpdateSpec",
              startLine: 1,
              endLine: 25,
              code: "test('updates', () => update({ key: 'k', value: 'v' }))",
            },
          ],
          edges: [
            {
              id: "e-test-update",
              fromNodeID: "fMemTest:case",
              toNodeID: "fMem:update",
              kind: "references",
            },
          ],
        })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.tests({ symbol: "MemoryRepo.update" })

        expect(result.tests.length).toBeGreaterThanOrEqual(1)
        const ids = result.tests.map((t) => t.id)
        expect(ids).toContain("fMemTest:case")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

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

describe("findTests import mapping", () => {
  test("returns exactly 6 matching tests when 6 test nodes import the symbol's module", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.writeFileGraph({
          file: {
            id: "target-file",
            path: "packages/core/src/banyancode/codegraph-build-service.ts",
            contentHash: "h1",
            language: "typescript",
            indexedAt: 1,
          },
          nodes: [
            {
              id: "target-symbol",
              fileID: "target-file",
              kind: "class",
              name: "CodegraphBuildService",
              signature: "class CodegraphBuildService",
              startLine: 1,
              endLine: 50,
              code: "class CodegraphBuildService {}",
            },
          ],
          edges: [],
        })
        for (let i = 1; i <= 6; i++) {
          yield* repo.writeFileGraph({
            file: {
              id: `test-file-${i}`,
              path: `packages/core/test/banyancode/codegraph-build-service${i === 1 ? "" : i === 2 ? "-alt" : i === 3 ? "-utils" : i === 4 ? "-helper" : i === 5 ? "-integration" : "-e2e"}.test.ts`,
              contentHash: `h${i + 1}`,
              language: "typescript",
              indexedAt: i + 1,
            },
            nodes: [
              {
                id: `test-node-${i}`,
                fileID: `test-file-${i}`,
                kind: "test",
                name: `Test${i}`,
                signature: `Test${i}()`,
                startLine: 1,
                endLine: 10,
                code: `import { CodegraphBuildService } from "../../../src/banyancode/codegraph-build-service";

describe("test", () => {
  it("works", () => {});
});`,
              },
            ],
            edges: [],
            bindings: [
              {
                id: `binding-${i}`,
                fileID: `test-file-${i}`,
                kind: "import",
                localName: "CodegraphBuildService",
                importedName: "CodegraphBuildService",
                exportName: "CodegraphBuildService",
                source: "../../../src/banyancode/codegraph-build-service",
                indexedAt: i + 1,
              },
            ],
          })
        }
        for (let i = 7; i <= 11; i++) {
          yield* repo.writeFileGraph({
            file: {
              id: `unrelated-file-${i}`,
              path: `packages/core/test/banyancode/unrelated-${i}.test.ts`,
              contentHash: `h${i}`,
              language: "typescript",
              indexedAt: i + 1,
            },
            nodes: [
              {
                id: `unrelated-test-${i}`,
                fileID: `unrelated-file-${i}`,
                kind: "test",
                name: `UnrelatedTest${i}`,
                signature: `UnrelatedTest${i}()`,
                startLine: 1,
                endLine: 10,
                code: `import { SomethingElse } from "@opencode-ai/core/something";

describe("unrelated", () => {
  it("works", () => {});
});`,
              },
            ],
            edges: [],
          })
        }

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.tests({ symbol: "CodegraphBuildService" })

        expect(result.notFound).toBe(false)
        expect(result.tests.length).toBe(6)
        // Per-result evidence: import bindings resolve to `import-binding`
        // with a moderate confidence — never raw-substring diagnostics.
        expect(result.results.length).toBe(6)
        expect(result.results.every((r) => r.derivation === "import-binding")).toBe(true)
        expect(result.results.every((r) => r.confidence === 60)).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("returns notFound true when no test nodes import the symbol", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "target-file",
          path: "packages/core/src/banyancode/some-symbol.ts",
          contentHash: "h1",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putFile({
          id: "test-file",
          path: "packages/core/test/banyancode/some-symbol.test.ts",
          contentHash: "h2",
          language: "typescript",
          indexedAt: 2,
        })

        yield* repo.putNode({
          id: "target-symbol",
          fileID: "target-file",
          kind: "function",
          name: "someFunction",
          signature: "someFunction()",
          startLine: 1,
          endLine: 20,
          code: "function someFunction() {}",
        })

        yield* repo.putNode({
          id: "test-node",
          fileID: "test-file",
          kind: "test",
          name: "Test",
          signature: "Test()",
          startLine: 1,
          endLine: 10,
          code: `import { OtherSymbol } from "@opencode-ai/core/other";

describe("test", () => {
  it("works", () => {});
});`,
        })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.tests({ symbol: "someFunction" })

        expect(result.tests.length).toBe(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("returns notFound true when symbol does not exist in graph", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "some-file",
          path: "packages/core/src/banyancode/other.ts",
          contentHash: "h1",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putNode({
          id: "some-node",
          fileID: "some-file",
          kind: "function",
          name: "otherFunction",
          signature: "otherFunction()",
          startLine: 1,
          endLine: 10,
          code: "function otherFunction() {}",
        })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.tests({ symbol: "NonExistentSymbol" })

        expect(result.notFound).toBe(true)
        expect(result.tests.length).toBe(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

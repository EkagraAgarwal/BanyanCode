import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { RepositoryIntelligence, defaultLayer as repositoryIntelligenceDefaultLayer } from "../../src/banyancode/repository-intelligence"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(repositoryIntelligenceDefaultLayer, CodegraphRepo.defaultLayer)

const seedWithAbsolutePath = (rootPath: string) =>
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service
    const absFilePath = path.join(rootPath, "src", "memory-repo.ts")
    yield* repo.putFile({
      id: "fMem",
      path: absFilePath,
      contentHash: "h1",
      language: "typescript",
      indexedAt: 1,
    })
    yield* repo.putNode({
      id: "nMem",
      fileID: "fMem",
      kind: "class",
      name: "Service",
      signature: "class Service",
      startLine: 1,
      endLine: 10,
      code: "export class Service extends Context.Service<Service, Interface>()('@banyancode/MemoryRepo') {}",
    })
    yield* repo.putFile({
      id: "fCaller",
      path: path.join(rootPath, "src", "caller.ts"),
      contentHash: "h2",
      language: "typescript",
      indexedAt: 2,
    })
    yield* repo.putNode({
      id: "nCaller",
      fileID: "fCaller",
      kind: "function",
      name: "boot",
      signature: "function boot()",
      startLine: 1,
      endLine: 5,
      code: "function boot() {}",
    })
    yield* repo.putEdge({ id: "e1", fromNodeID: "nCaller", toNodeID: "nMem", kind: "calls" })
    yield* repo.setMeta({
      id: "singleton",
      graphBuiltAt: 1,
      graphVersion: 1,
      graphCoverage: 1,
      totalFiles: 2,
      totalNodes: 2,
      totalEdges: 1,
      schemaVersion: 1,
      indexedRoot: rootPath,
    })
  })

describe("P2 regression: path lookup accepts absolute, root-prefixed, and suffix forms", () => {
  test("impact() resolves an absolute Windows-style path", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const indexedRoot = path.join(tmp.path, "repo")

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWithAbsolutePath(indexedRoot)
        const ri = yield* RepositoryIntelligence.Service
        const abs = path.join(indexedRoot, "src", "memory-repo.ts")
        const slc = yield* ri.impact({ path: abs })
        // Caller `boot` should appear as a direct caller of the file's nodes.
        expect(slc.directCallers.some((n) => n.id === "nCaller")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("impact() resolves a relative path (legacy form)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const indexedRoot = path.join(tmp.path, "repo")

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWithAbsolutePath(indexedRoot)
        const ri = yield* RepositoryIntelligence.Service
        const slc = yield* ri.impact({ path: "src/memory-repo.ts" })
        expect(slc.directCallers.some((n) => n.id === "nCaller")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("impact() resolves a backslash path against indexed_root", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const indexedRoot = path.join(tmp.path, "repo")

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWithAbsolutePath(indexedRoot)
        const ri = yield* RepositoryIntelligence.Service
        const slc = yield* ri.impact({ path: "src\\memory-repo.ts" })
        expect(slc.directCallers.some((n) => n.id === "nCaller")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("suffix fallback rejects ambiguous matches", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const indexedRoot = path.join(tmp.path, "repo")

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        // Two files that both end with `util.ts` — suffix match must
        // not pick one arbitrarily.
        yield* repo.putFile({
          id: "f1",
          path: path.join(indexedRoot, "packages", "a", "src", "util.ts"),
          contentHash: "h1",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putNode({
          id: "n1",
          fileID: "f1",
          kind: "function",
          name: "fn1",
          signature: "fn1()",
          startLine: 1,
          endLine: 1,
          code: "function fn1() {}",
        })
        yield* repo.putFile({
          id: "f2",
          path: path.join(indexedRoot, "packages", "b", "src", "util.ts"),
          contentHash: "h2",
          language: "typescript",
          indexedAt: 2,
        })
        yield* repo.putNode({
          id: "n2",
          fileID: "f2",
          kind: "function",
          name: "fn2",
          signature: "fn2()",
          startLine: 1,
          endLine: 1,
          code: "function fn2() {}",
        })
        yield* repo.setMeta({
          id: "singleton",
          graphBuiltAt: 1,
          graphVersion: 1,
          graphCoverage: 1,
          totalFiles: 2,
          totalNodes: 2,
          totalEdges: 0,
          schemaVersion: 1,
          indexedRoot,
        })

        const ri = yield* RepositoryIntelligence.Service
        // Bare "util.ts" — no candidate resolves (no exact, no root-prefixed,
        // no root-stripped, two suffix matches → ambiguity, so we return
        // undefined and the impact() falls through to query+slice).
        const slc = yield* ri.impact({ path: "util.ts" })
        // Ambiguous suffix returns no direct callers (the safe behavior).
        expect(slc.directCallers).toHaveLength(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

describe("P2 regression: FTS runs on multi-token queries regardless of doc substring matches", () => {
  test("multi-token query surfaces code symbols when docs also match the phrase", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        yield* repo.putFile({
          id: "fDoc",
          path: "docs/index.md",
          contentHash: "h1",
          language: "markdown",
          indexedAt: 1,
        })
        yield* repo.putNode({
          id: "nDoc",
          fileID: "fDoc",
          kind: "doc",
          name: "codegraph indexer",
          signature: "docs/index.md",
          startLine: 1,
          endLine: 5,
          code: "The codegraph indexer builds the searchable graph.",
        })
        yield* repo.putFile({
          id: "fCode",
          path: "src/codegraph-indexer.ts",
          contentHash: "h2",
          language: "typescript",
          indexedAt: 2,
        })
        yield* repo.putNode({
          id: "nCode",
          fileID: "fCode",
          kind: "class",
          name: "CodegraphIndexer",
          signature: "class CodegraphIndexer",
          startLine: 1,
          endLine: 10,
          // FTS5 default tokenizer does NOT split camelCase, so embed the
          // phrase as separate tokens in `code` to make the FTS hit
          // meaningful (the production indexer indexes real code with
          // spaces and comments that produce separate tokens).
          code: "// codegraph module: indexer builds the searchable graph\nexport class CodegraphIndexer { build() {} }",
        })
        yield* repo.rebuildFtsIndex()

        const ri = yield* RepositoryIntelligence.Service
        const ctx = yield* ri.query({ query: "codegraph indexer" })
        // FTS code hit must be present despite the doc substring match.
        const ids = ctx.symbols.map((n) => n.id)
        expect(ids).toContain("nCode")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

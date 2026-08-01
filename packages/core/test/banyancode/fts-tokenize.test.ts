import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

/**
 * Phase 3 FTS quality — trigram tokenizer regression suite.
 *
 * Locks the partial-identifier contract that the trigram tokenizer
 * (added in 20260801120000_codegraph_fts_tokenize) is supposed to
 * provide. Before this migration, a query like `codegraph` against a
 * row whose name is `CodegraphBuildService` would only match via the
 * LIKE-substring resolver in `findSymbol`, not via FTS5 — the
 * `unicode61` tokenizer requires whole-token matches. With trigram
 * the 3-character substrings `cod`, `odg`, `dgr`, `gra`, `rap`, `aph`
 * are all indexed, so a 3+ character query like `codegraph` matches
 * the row.
 *
 * Each test seeds a single file with three nodes representing the
 * three identifier styles a real codebase mixes: camelCase / PascalCase
 * (`CodegraphBuildService`), kebab-case (`codegraph-build-service`),
 * and snake_case (`codegraph_repo`). It then issues three partial
 * queries (`codegraph`, `build`, `service`) and asserts the FTS
 * backend returns the matching row, regardless of which identifier
 * style the row uses.
 */

const testLayer = Layer.mergeAll(CodegraphRepo.defaultLayer)

const seedIdentifierMatrix = (repo: CodegraphRepo.Interface) =>
  Effect.gen(function* () {
    yield* repo.putFile({
      id: "file-ids",
      path: "src/identifier-matrix.ts",
      contentHash: "h-ids",
      language: "typescript",
      indexedAt: 1,
    })

    // camelCase / PascalCase
    yield* repo.putNode({
      id: "id-camel",
      fileID: "file-ids",
      kind: "class",
      name: "CodegraphBuildService",
      signature: "class CodegraphBuildService",
      startLine: 1,
      endLine: 10,
      code: "class CodegraphBuildService {}",
    })

    // kebab-case
    yield* repo.putNode({
      id: "id-kebab",
      fileID: "file-ids",
      kind: "function",
      name: "codegraph-build-service",
      signature: "codegraph-build-service()",
      startLine: 11,
      endLine: 20,
      code: "function codegraph-build-service() {}",
    })

    // snake_case
    yield* repo.putNode({
      id: "id-snake",
      fileID: "file-ids",
      kind: "function",
      name: "codegraph_repo",
      signature: "codegraph_repo()",
      startLine: 21,
      endLine: 30,
      code: "function codegraph_repo() {}",
    })
  })

describe("FTS quality — trigram tokenizer", () => {
  test("partial query `codegraph` matches every identifier style in the seed", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const matchedIDs = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* seedIdentifierMatrix(repo)

        const hits = yield* repo.ftsSearchNodes({ query: "codegraph", limit: 50 })
        return new Set(hits.map((h) => h.id))
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(matchedIDs.has("id-camel")).toBe(true)
    expect(matchedIDs.has("id-kebab")).toBe(true)
    expect(matchedIDs.has("id-snake")).toBe(true)
  })

  test("partial query `build` matches the camelCase and kebab-case rows", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const matchedIDs = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* seedIdentifierMatrix(repo)

        const hits = yield* repo.ftsSearchNodes({ query: "build", limit: 50 })
        return new Set(hits.map((h) => h.id))
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(matchedIDs.has("id-camel")).toBe(true)
    expect(matchedIDs.has("id-kebab")).toBe(true)
    // snake_case `codegraph_repo` does not contain the substring `build`,
    // so it must not match.
    expect(matchedIDs.has("id-snake")).toBe(false)
  })

  test("partial query `service` matches the camelCase and kebab-case rows", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const matchedIDs = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* seedIdentifierMatrix(repo)

        const hits = yield* repo.ftsSearchNodes({ query: "service", limit: 50 })
        return new Set(hits.map((h) => h.id))
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(matchedIDs.has("id-camel")).toBe(true)
    expect(matchedIDs.has("id-kebab")).toBe(true)
    expect(matchedIDs.has("id-snake")).toBe(false)
  })
})

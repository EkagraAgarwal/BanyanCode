import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo, expandQueryToTokens } from "@opencode-ai/core/banyancode/codegraph-repo"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

/**
 * Phase 3 FTS quality — identifier query expansion regression suite.
 *
 * Locks the contract that `expandQueryToTokens` (in codegraph-repo.ts)
 * splits an identifier-style query into its sub-tokens so a single
 * query like `CodegraphBuildService` (or `codegraph-build-service`,
 * or `codegraph build service`) maps to FTS5 OR-terms that match
 * either the full identifier or any of its sub-tokens. The trigram
 * tokenizer in the FTS5 table then partial-matches the OR'd sub-
 * tokens against the seeded row.
 *
 * The first test (`expandQueryToTokens: pure function`) is a direct
 * unit test of the helper: no DB, no Effect. It locks the split
 * rules so a future refactor that drops camelCase handling, drops
 * non-alphanumeric splitting, or shortens the min token length
 * surfaces here.
 *
 * The second test (FTS roundtrip) seeds a row whose name is
 * `BuildService` and queries with `CodegraphBuildService`. The
 * expansion produces `codegraph`, `build`, `service`; the FTS5 MATCH
 * OR-joins them; the trigram tokenizer on the row's `name` column
 * matches the `build` and `service` substrings; the row appears in
 * the result set.
 */

const testLayer = Layer.mergeAll(CodegraphRepo.defaultLayer)

describe("FTS quality — query expansion", () => {
  test("expandQueryToTokens: PascalCase splits on camelCase boundaries", () => {
    const tokens = expandQueryToTokens("CodegraphBuildService")
    // Order is preserved within a single piece; lowercased; ≥ 3 chars.
    expect(tokens).toEqual(["codegraph", "build", "service"])
  })

  test("expandQueryToTokens: kebab-case splits on dashes", () => {
    const tokens = expandQueryToTokens("codegraph-build-service")
    expect(tokens).toEqual(["codegraph", "build", "service"])
  })

  test("expandQueryToTokens: snake_case splits on underscores", () => {
    const tokens = expandQueryToTokens("codegraph_repo")
    expect(tokens).toEqual(["codegraph", "repo"])
  })

  test("expandQueryToTokens: contiguous uppercase run followed by lowercase splits before the lowercase letter (XMLParser → xml parser)", () => {
    const tokens = expandQueryToTokens("XMLParser")
    expect(tokens).toEqual(["xml", "parser"])
  })

  test("expandQueryToTokens: dedupes repeated tokens", () => {
    const tokens = expandQueryToTokens("CodegraphBuildService codegraph build service")
    // The repetition must collapse; order from the first occurrence wins.
    expect(tokens).toEqual(["codegraph", "build", "service"])
  })

  test("expandQueryToTokens: drops sub-3-character tokens (trigram floor)", () => {
    // The trigram FTS5 tokenizer needs at least 3 characters per token;
    // the expansion helper mirrors that constraint so a 1- or 2-char
    // token can never reach the FTS5 query (where it would silently
    // match nothing and add noise). `xyz` is the floor and is kept.
    const tokens = expandQueryToTokens("ab a codegraph-build-service xyz")
    expect(tokens).toEqual(["codegraph", "build", "service", "xyz"])
  })

  test("FTS roundtrip: querying `CodegraphBuildService` hits a row named `BuildService`", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const hits = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "file-expansion",
          path: "src/expansion-target.ts",
          contentHash: "h-exp",
          language: "typescript",
          indexedAt: 1,
        })

        // The target row whose name is `BuildService` — does NOT contain
        // the full literal `codegraph`, but DOES contain the substring
        // `build` and `service` that the expanded query will match.
        yield* repo.putNode({
          id: "row-buildservice",
          fileID: "file-expansion",
          kind: "class",
          name: "BuildService",
          signature: "class BuildService",
          startLine: 1,
          endLine: 10,
          code: "class BuildService {}",
        })

        // Noise row whose name does NOT contain any of the expanded
        // tokens; the query must not surface it.
        yield* repo.putNode({
          id: "row-noise",
          fileID: "file-expansion",
          kind: "function",
          name: "unrelatedName",
          signature: "unrelatedName()",
          startLine: 11,
          endLine: 20,
          code: "function unrelatedName() {}",
        })

        const expanded = expandQueryToTokens("CodegraphBuildService")
        const ftsHits = yield* repo.ftsSearchNodes({ query: "CodegraphBuildService", limit: 50 })
        return { expanded, ftsHits }
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    // The expansion must produce the three sub-tokens we expect.
    expect(hits.expanded).toEqual(["codegraph", "build", "service"])

    // The trigram + expanded-query combination must surface the
    // `BuildService` row (matched via the `build` and `service`
    // substrings of its name) and must not surface the noise row.
    const matchedIDs = new Set(hits.ftsHits.map((h) => h.id))
    expect(matchedIDs.has("row-buildservice")).toBe(true)
    expect(matchedIDs.has("row-noise")).toBe(false)
  })
})

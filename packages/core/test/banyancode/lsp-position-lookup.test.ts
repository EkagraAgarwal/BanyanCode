import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "../../src/database/database"
import { DatabaseMigration } from "../../src/database/migration"
import { CodegraphRepo } from "../../src/banyancode/codegraph-repo"
import { lookupSymbolAtPosition } from "../../src/tool/lsp-tools"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

// Phase 5 (LSP tools). `lookupSymbolAtPosition` backs lsp_definition,
// lsp_references and lsp_hover: among every codegraph node in the requested
// file whose [startLine, endLine] span contains the requested line, it returns
// the one with the smallest span. It is exported purely so the ranking can be
// asserted directly — the four tool factories are module-private.

const FILE_PATH = "src/example.ts"
const OTHER_FILE_PATH = "src/other.ts"

const seedGraph = (repo: CodegraphRepo.Interface) =>
  Effect.gen(function* () {
    yield* repo.putFile({
      id: "file-example",
      path: FILE_PATH,
      contentHash: "h-example",
      language: "typescript",
      indexedAt: 1,
    })
    yield* repo.putFile({
      id: "file-other",
      path: OTHER_FILE_PATH,
      contentHash: "h-other",
      language: "typescript",
      indexedAt: 2,
    })

    // A file node spans the whole file, so it contains every queryable line.
    // The lookup must never return it.
    yield* repo.putNode({
      id: "node-file",
      fileID: "file-example",
      kind: "file",
      name: FILE_PATH,
      startLine: 1,
      endLine: 200,
    })
    yield* repo.putNode({
      id: "node-outer",
      fileID: "file-example",
      kind: "class",
      name: "OuterClass",
      startLine: 1,
      endLine: 50,
      signature: "class OuterClass",
    })
    yield* repo.putNode({
      id: "node-inner",
      fileID: "file-example",
      kind: "method",
      name: "innerMethod",
      startLine: 10,
      endLine: 14,
      signature: "innerMethod(): void",
    })
    // Same span as the inner method but in a different file — proves the
    // candidate set is filtered by fileID before the span comparison.
    yield* repo.putNode({
      id: "node-decoy",
      fileID: "file-other",
      kind: "function",
      name: "decoy",
      startLine: 10,
      endLine: 14,
    })
  })

const lookup = async (target: string, line: number) => {
  await using tmp = await tmpdir()
  const dbLayer = Database.layerFromPath(path.join(tmp.path, "lsp.db"))
  return await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* DatabaseMigration.apply(db)
      const repo = (yield* CodegraphRepo.Service) as unknown as CodegraphRepo.Interface
      yield* seedGraph(repo)
      return yield* lookupSymbolAtPosition(repo, target, line)
    }).pipe(Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
  )
}

describe("lookupSymbolAtPosition", () => {
  test("a line inside both spans resolves to the smaller, more specific symbol", async () => {
    const symbol = await lookup(FILE_PATH, 12)
    expect(symbol?.id).toBe("node-inner")
    expect(symbol?.name).toBe("innerMethod")
    expect(symbol?.kind).toBe("method")
    expect(symbol?.startLine).toBe(10)
    expect(symbol?.endLine).toBe(14)
    expect(symbol?.signature).toBe("innerMethod(): void")
  })

  test("a line inside only the outer span resolves to the outer symbol", async () => {
    const symbol = await lookup(FILE_PATH, 30)
    expect(symbol?.id).toBe("node-outer")
    expect(symbol?.name).toBe("OuterClass")
  })

  test("the boundary lines of the inner span are inclusive", async () => {
    const first = await lookup(FILE_PATH, 10)
    const last = await lookup(FILE_PATH, 14)
    expect(first?.id).toBe("node-inner")
    expect(last?.id).toBe("node-inner")
    // One line past the end falls back to the enclosing class.
    const after = await lookup(FILE_PATH, 15)
    expect(after?.id).toBe("node-outer")
  })

  test("file nodes are excluded even though their span covers the line", async () => {
    // Line 60 sits inside the file node (1-200) and outside every symbol, so a
    // non-undefined result here would mean the `kind !== "file"` filter broke.
    const symbol = await lookup(FILE_PATH, 60)
    expect(symbol).toBeUndefined()
  })

  test("a line outside every span returns undefined", async () => {
    const symbol = await lookup(FILE_PATH, 500)
    expect(symbol).toBeUndefined()
  })

  test("an unindexed file returns undefined", async () => {
    const symbol = await lookup("src/missing.ts", 12)
    expect(symbol).toBeUndefined()
  })

  test("a bare filename resolves through the path-suffix match", async () => {
    const symbol = await lookup("example.ts", 12)
    expect(symbol?.id).toBe("node-inner")
  })

  test("nodes from another file never win the span comparison", async () => {
    const symbol = await lookup(OTHER_FILE_PATH, 12)
    expect(symbol?.id).toBe("node-decoy")
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { parseGeneric } from "../../src/banyancode/langs/registry"
import { parsePython } from "../../src/banyancode/langs/python"
import { ensureWebTreeSitterReady } from "../../src/banyancode/langs/tree-sitter"

// Regression tests for the edge-mode evaluation triage:
//  - BUG 2: parseGeneric (go/rust/java/php/ruby) never filled node.code, so
//    rebuildDerivedGraph's identifier scan had nothing to scan and those
//    languages contributed ZERO call edges in both modes. Functions/classes
//    now carry body code (brace-balanced, ~4000-char window).
//  - BUG 3: getPythonNodeBody returned empty code for defs not at line 1
//    (the signature-newline scan started at the `(?:^|\n)` anchor, which IS
//    the newline before the def), starving python call edges too.
//  - BUG 1: the regex parsers' startLine now points at the DECLARATION line
//    (matching tree-sitter's `startPosition.row + 1`), so the parser-mode
//    remap resolves `:function:<line>` endpoints for callers that are not
//    on line 1 (python path exercised below; the TS path is covered in
//    codegraph-tree-sitter.test.ts).
process.env.BANYANCODE_ENABLE = "1"

const setEdgesMode = (mode: "derived" | "parser" | undefined): void => {
  if (mode === undefined) delete process.env.BANYANCODE_TS_EDGES
  else process.env.BANYANCODE_TS_EDGES = mode
}

afterEach(() => {
  setEdgesMode(undefined)
})

const serviceLayer = CodegraphIndexer.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(codegraphRepoDefaultLayer),
)

// handleRequest at line 5 calls logRequest at line 3; main at line 9 calls
// handleRequest.
const GO_FIXTURE = `package main

func logRequest() {}

func handleRequest() {
    logRequest()
}

func main() {
    handleRequest()
}
`

const RUST_FIXTURE = `fn helper() -> i32 {
    1
}

fn compute() -> i32 {
    helper()
}
`

// helper at line 5 (NOT line 1) called from caller at line 9 (call at line 10).
const PY_FIXTURE = `# helper lives at line 5 (not line 1) and is called from line 10
import os


def helper():
    return os.getcwd()


def caller():
    value = helper()
    return value
`

const writeFixture = async (root: string, name: string, content: string): Promise<void> => {
  await fs.writeFile(path.join(root, name), content)
}

const indexRoot = (root: string): Promise<{
  indexed: number
  skippedByReason: Record<string, number>
  parseErrors: Array<{ path: string; cause: string; indexedAt: number }>
}> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const indexer = yield* CodegraphIndexer.Service
      return yield* indexer.index({ root, force: true })
    }).pipe(Effect.provide(serviceLayer), Effect.provide(Database.layerFromPath(path.join(root, "graph.sqlite"))), Effect.scoped),
  )

describe("code-less languages gain call edges (edge-mode eval triage)", () => {
  test("parseGeneric fills node.code and declaration lines for go/rust", () => {
    const go = parseGeneric(GO_FIXTURE, "go-id")
    const handle = go.nodes.find((n) => n.kind === "function" && n.name === "handleRequest")
    expect(handle?.startLine).toBe(5)
    expect(handle?.code).toContain("logRequest()")
    expect(handle?.endLine).toBe(7)
    const log = go.nodes.find((n) => n.kind === "function" && n.name === "logRequest")
    expect(log?.startLine).toBe(3)
    expect(log?.code).toContain("logRequest")

    const rust = parseGeneric(RUST_FIXTURE, "rs-id")
    const compute = rust.nodes.find((n) => n.kind === "function" && n.name === "compute")
    expect(compute?.startLine).toBe(5)
    expect(compute?.code).toContain("helper()")
    expect(rust.nodes.find((n) => n.name === "helper")?.startLine).toBe(1)
  })

  test("parsePython fills code for defs not at line 1 and aligns their lines", () => {
    const result = parsePython(PY_FIXTURE, "py-id")
    const helper = result.nodes.find((n) => n.kind === "function" && n.name === "helper")
    expect(helper?.startLine).toBe(5)
    expect(helper?.code?.length ?? 0).toBeGreaterThan(0)
    expect(helper?.code).toContain("getcwd")
    const caller = result.nodes.find((n) => n.kind === "function" && n.name === "caller")
    expect(caller?.startLine).toBe(9)
    expect(caller?.code).toContain("helper()")
  })

  test("go (derived mode): handleRequest -> logRequest calls edge exists", async () => {
    await using tmp = await tmpdir()
    await writeFixture(tmp.path, "main.go", GO_FIXTURE)
    setEdgesMode(undefined) // default derived

    const result = await indexRoot(tmp.path)
    expect(result.indexed).toBeGreaterThanOrEqual(1)
    expect(result.parseErrors).toEqual([])

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const { db } = yield* Database.Service
        const file = (yield* repo.listAllFiles()).find((f) => f.path.endsWith("main.go"))
        expect(file).toBeDefined()
        if (!file) return
        const edge = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges
          WHERE kind = 'calls'
            AND from_node_id = ${`${file.id}:function:handleRequest:5`}
            AND to_node_id = ${`${file.id}:function:logRequest:3`}
        `)
        expect(edge?.c ?? 0).toBe(1)
      }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(Database.layerFromPath(path.join(tmp.path, "graph.sqlite"))), Effect.scoped),
    )
  })

  test("python (derived mode): caller -> helper calls edge exists with helper code", async () => {
    await using tmp = await tmpdir()
    await writeFixture(tmp.path, "main.py", PY_FIXTURE)
    setEdgesMode(undefined) // default derived

    const result = await indexRoot(tmp.path)
    expect(result.indexed).toBeGreaterThanOrEqual(1)

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const { db } = yield* Database.Service
        const file = (yield* repo.listAllFiles()).find((f) => f.path.endsWith("main.py"))
        expect(file).toBeDefined()
        if (!file) return
        // BUG 3: the def at line 5 must carry code in the DB.
        const helperCode = yield* db.get<{ c: string | null }>(sql`
          SELECT code AS c FROM codegraph_nodes WHERE id = ${`${file.id}:function:helper:5`}
        `)
        expect(helperCode?.c?.length ?? 0).toBeGreaterThan(0)
        const edge = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges
          WHERE kind = 'calls'
            AND from_node_id = ${`${file.id}:function:caller:9`}
            AND to_node_id = ${`${file.id}:function:helper:5`}
        `)
        expect(edge?.c ?? 0).toBe(1)
      }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(Database.layerFromPath(path.join(tmp.path, "graph.sqlite"))), Effect.scoped),
    )
  })

  test("python (parser mode): tree-sitter call edge survives the remap for a caller off line 1", async () => {
    await using tmp = await tmpdir()
    await writeFixture(tmp.path, "main.py", PY_FIXTURE)
    setEdgesMode("parser")
    await Effect.runPromise(ensureWebTreeSitterReady())

    const result = await indexRoot(tmp.path)
    expect(result.indexed).toBeGreaterThanOrEqual(1)

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const { db } = yield* Database.Service
        const file = (yield* repo.listAllFiles()).find((f) => f.path.endsWith("main.py"))
        expect(file).toBeDefined()
        if (!file) return
        // caller (line 9) -> helper (line 5): the tree-sitter from-endpoint
        // is `:function:9` and the regex caller node must sit at line 9
        // for the remap to resolve it (BUG 1 root fix).
        const parserCall = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges
          WHERE kind = 'calls' AND id LIKE '%:calls:helper:%'
            AND from_node_id = ${`${file.id}:function:caller:9`}
            AND to_node_id = ${`${file.id}:function:helper:5`}
        `)
        expect(parserCall?.c ?? 0).toBe(1)
      }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(Database.layerFromPath(path.join(tmp.path, "graph.sqlite"))), Effect.scoped),
    )
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import {
  _resetTreeSitterStateForTesting,
  ensureWebTreeSitterReady,
  treeSitterStateRef,
} from "../../src/banyancode/langs/tree-sitter"
import { parseTypeScriptWithTreeSitter, ensureQuerySourcesLoaded } from "../../src/banyancode/langs/query-executor"

process.env.BANYANCODE_ENABLE = "1"

// Phase 0 tree-sitter: the indexer's TS/JS/Python dispatch routes through
// the tree-sitter parse path (node extraction stays regex; tree-sitter adds
// query edges + syntax-error detection), and BANYANCODE_TS_EDGES switches
// between the derived edge lifecycle (default) and parser-owned call edges.
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

// Intra-file call (alpha → beta) plus an extends pair so both parser-owned
// `calls` and derived `extends` are exercised. The leading comment line
// keeps `alpha` OFF line 1: the tree-sitter caller endpoint is
// `startPosition.row + 1` (line 2), and the regex parsers must compute the
// same declaration line or the parser-edge remap silently drops every
// parser-owned edge for the file (historical off-by-one: regex anchored on
// the consumed `\n` and reported the line BEFORE the declaration).
const TS_FIXTURE = `// header keeps alpha off line 1
export function alpha() {
  return beta()
}

export function beta() {
  return 42
}

export class Base {}

export class Derived extends Base {}
`

const MALFORMED_TS = `export function broken() {
  return 1
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

describe("codegraph tree-sitter backend (Phase 0)", () => {
  test("TS fixture indexes via the tree-sitter path; nodes carry the backend marker", async () => {
    await using tmp = await tmpdir()
    await writeFixture(tmp.path, "main.ts", TS_FIXTURE)
    await Effect.runPromise(Effect.promise(() => ensureQuerySourcesLoaded()))
    await Effect.runPromise(ensureWebTreeSitterReady())

    const result = await indexRoot(tmp.path)
    expect(result.indexed).toBeGreaterThanOrEqual(1)
    expect(result.skippedByReason.parseFailure).toBe(0)
    expect(result.parseErrors).toEqual([])

    // The file's symbol nodes are present in the graph.
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const alpha = yield* repo.queryNodes({ function: "alpha" })
        const beta = yield* repo.queryNodes({ function: "beta" })
        expect(alpha.length).toBeGreaterThanOrEqual(1)
        expect(beta.length).toBeGreaterThanOrEqual(1)
      }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(Database.layerFromPath(path.join(tmp.path, "graph.sqlite"))), Effect.scoped),
    )

    // The backend marker that drives the "tree-sitter-v1" / "regex-v1"
    // derivation stamp: either is valid depending on wasm availability in
    // the test env. (Node derivation is an in-memory index-time field, not
    // a DB column, so the marker is the observable.)
    const parsed = await Effect.runPromise(parseTypeScriptWithTreeSitter(TS_FIXTURE, "probe-id"))
    expect(parsed.backend ?? "regex").toBeOneOf(["tree-sitter", "regex"])
    if (parsed.backend === "tree-sitter") {
      expect(parsed.nodes.some((n) => n.kind === "function" && n.name === "alpha")).toBe(true)
      expect(parsed.edges.some((e) => e.source === "tree-sitter" && e.kind === "calls" && e.toNodeID === "symbol:beta")).toBe(true)
    }
  })

  test("malformed TS records a real parse error and continues with the regex fallback", async () => {
    await using tmp = await tmpdir()
    await writeFixture(tmp.path, "broken.ts", MALFORMED_TS)
    await Effect.runPromise(ensureWebTreeSitterReady())

    const result = await indexRoot(tmp.path)
    // Record + continue: the file still indexes with regex fallback nodes.
    expect(result.indexed).toBeGreaterThanOrEqual(1)
    expect(result.skippedByReason.parseFailure).toBeGreaterThanOrEqual(1)

    const recorded = result.parseErrors.find((e) => e.path === "broken.ts")
    expect(recorded).toBeDefined()
    // "tree-sitter syntax error at line N: missing '}'" when the wasm bundle
    // is available, "tree-sitter unavailable: <cause>" when it is not — the
    // real-message requirement holds either way.
    expect(recorded!.cause).toMatch(/tree-sitter/)

    // Regex fallback nodes are present for the malformed file.
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const broken = yield* repo.queryNodes({ function: "broken" })
        expect(broken.length).toBeGreaterThanOrEqual(1)
      }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(Database.layerFromPath(path.join(tmp.path, "graph.sqlite"))), Effect.scoped),
    )
  })

  test("BANYANCODE_TS_EDGES=derived (default): parser-emitted call edges never reach the graph", async () => {
    await using tmp = await tmpdir()
    await writeFixture(tmp.path, "main.ts", TS_FIXTURE)
    setEdgesMode(undefined) // default

    const result = await indexRoot(tmp.path)
    expect(result.indexed).toBeGreaterThanOrEqual(1)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        // No parser-format call edges (id has no "->"): byte-identical with
        // today's derived lifecycle.
        const parserCalls = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges
          WHERE id LIKE '%:calls:%' AND id NOT LIKE '%->%'
        `)
        expect(parserCalls?.c ?? 0).toBe(0)
        // No symbolic parser targets at all.
        const symbolTargets = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges
          WHERE to_node_id LIKE 'symbol:%' OR to_node_id LIKE 'service:%'
        `)
        expect(symbolTargets?.c ?? 0).toBe(0)
        // Derived edges DO exist (alpha -> beta calls, Derived extends Base).
        const derivedCalls = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges WHERE kind = 'calls' AND id LIKE '%->%'
        `)
        expect(derivedCalls?.c ?? 0).toBeGreaterThanOrEqual(1)
        const extendsEdges = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges WHERE kind = 'extends'
        `)
        expect(extendsEdges?.c ?? 0).toBeGreaterThanOrEqual(1)
      }).pipe(Effect.provide(Database.layerFromPath(path.join(tmp.path, "graph.sqlite"))), Effect.scoped),
    )
  })

  test.skipIf(false)(
    "BANYANCODE_TS_EDGES=parser: tree-sitter call edges survive; derived calls are not regenerated",
    async () => {
      await using tmp = await tmpdir()
      await writeFixture(tmp.path, "main.ts", TS_FIXTURE)
      setEdgesMode("parser")
      await Effect.runPromise(ensureWebTreeSitterReady())

      const result = await indexRoot(tmp.path)
      expect(result.indexed).toBeGreaterThanOrEqual(1)

      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          const { db } = yield* Database.Service
          const file = (yield* repo.listAllFiles()).find((f) => f.path.endsWith("main.ts"))
          expect(file).toBeDefined()

          // The tree-sitter call edge (alpha calls beta) survives with its
          // endpoints remapped onto the real same-file nodes (the edges
          // table FK-enforces both endpoints onto codegraph_nodes). alpha
          // is on line 2 (not 1) and beta on line 6 — the remap must match
          // the tree-sitter `startPosition.row + 1` lines against the
          // regex parsers' DECLARATION lines. An off-by-one in the regex
          // startLine (or a tolerant ±1 fallback resolving to line 1/5)
          // fails the exact endpoint assertions below.
          const parserCall = yield* db.get<{ c: number }>(sql`
            SELECT COUNT(*) AS c FROM codegraph_edges
            WHERE kind = 'calls' AND id LIKE '%:calls:beta:%'
              AND from_node_id = ${`${file!.id}:function:alpha:2`}
              AND to_node_id = ${`${file!.id}:function:beta:6`}
          `)
          expect(parserCall?.c ?? 0).toBe(1)

          // The regex parser's node lines agree with tree-sitter: alpha's
          // declaration line is 2 and beta's is 6.
          const alphaLine = yield* db.get<{ l: number }>(sql`
            SELECT start_line AS l FROM codegraph_nodes WHERE id = ${`${file!.id}:function:alpha:2`}
          `)
          expect(alphaLine?.l).toBe(2)
          const betaLine = yield* db.get<{ l: number }>(sql`
            SELECT start_line AS l FROM codegraph_nodes WHERE id = ${`${file!.id}:function:beta:6`}
          `)
          expect(betaLine?.l).toBe(6)

          // Derived calls regeneration is skipped for the tree-sitter-parsed
          // file: no derived (-> id) calls edge at all.
          const derivedCall = yield* db.get<{ c: number }>(sql`
            SELECT COUNT(*) AS c FROM codegraph_edges
            WHERE kind = 'calls' AND id LIKE '%->%'
          `)
          expect(derivedCall?.c ?? 0).toBe(0)

          // Non-calls kinds stay derived: Derived extends Base edge.
          const derivedExtends = yield* db.get<{ c: number }>(sql`
            SELECT COUNT(*) AS c FROM codegraph_edges
            WHERE kind = 'extends' AND id LIKE '%->%' AND from_node_id LIKE ${`${file!.id}%`}
          `)
          expect(derivedExtends?.c ?? 0).toBeGreaterThanOrEqual(1)
        }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(Database.layerFromPath(path.join(tmp.path, "graph.sqlite"))), Effect.scoped),
      )
    },
  )

  test("ensureWebTreeSitterReady is called once per build and is idempotent", async () => {
    await using tmp = await tmpdir()
    await writeFixture(tmp.path, "main.ts", TS_FIXTURE)
    await Effect.runPromise(_resetTreeSitterStateForTesting())

    // The indexer primes the bundle at build start (state was uninitialized).
    const result = await indexRoot(tmp.path)
    expect(result.indexed).toBeGreaterThanOrEqual(1)
    const afterIndex = await Effect.runPromise(Ref.get(treeSitterStateRef))
    expect(afterIndex._tag).toBe("ready")

    // Subsequent calls are idempotent: state stays ready and the parser
    // bundle is not re-initialized (same object reference).
    await Effect.runPromise(ensureWebTreeSitterReady())
    const second = await Effect.runPromise(Ref.get(treeSitterStateRef))
    expect(second._tag).toBe("ready")
    await Effect.runPromise(ensureWebTreeSitterReady())
    const third = await Effect.runPromise(Ref.get(treeSitterStateRef))
    expect(third._tag).toBe("ready")
    if (second._tag === "ready" && third._tag === "ready") {
      expect(second.parser).toBe(third.parser)
    }
  })
})

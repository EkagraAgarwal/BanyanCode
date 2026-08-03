import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"

process.env.BANYANCODE_ENABLE = "1"

// Regression lock: parser-produced edges (regex `imports` with `module:`
// targets; tree-sitter `calls`/`yield`/`service_access` with `symbol:`/
// `service:` targets) must NEVER reach the DB. The same-file knownNodeIDs
// filter in indexCandidateFileCore already drops them, and the derived-edge
// lifecycle purges derived kinds on every build. This test pins that
// behavior so the tree-sitter decoupling cannot silently regress it.
describe("parser edges never reach the DB", () => {
  test("after a full index every edge references existing nodes and no parser-only target forms exist", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    // Fixture: a TS file with an import statement, a function calling another
    // function, and a class; a PY file with a def and a class; a package.json.
    const srcDir = path.join(tmp.path, "src")
    await fs.mkdir(srcDir, { recursive: true })
    await fs.writeFile(
      path.join(srcDir, "main.ts"),
      `import { helper } from "./helper"

function alpha() {
  return beta()
}

function beta() {
  return 42
}

export class Widget {
  render() {
    return alpha()
  }
}
`,
    )
    await fs.writeFile(
      path.join(srcDir, "helper.py"),
      `def helper():
    return 1

class Helper:
    def method(self):
        return 2
`,
    )
    await fs.writeFile(path.join(tmp.path, "package.json"), `{"name": "fixture", "version": "1.0.0"}\n`)

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({ root: tmp.path, force: true })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
    expect(result.indexed).toBeGreaterThan(0)

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const { db } = yield* Database.Service

        // The derived pass must actually produce edges for this fixture
        // (same-file `calls` from alpha -> beta and Widget.render -> alpha),
        // otherwise the assertion below would pass vacuously.
        const edgeCountRow = yield* db.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM codegraph_edges`)
        const edgeCount = edgeCountRow?.c ?? 0
        expect(edgeCount).toBeGreaterThan(0)

        // 1. Every edge endpoint exists in codegraph_nodes (JOIN check).
        const orphanEndpoints = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c
          FROM codegraph_edges e
          LEFT JOIN codegraph_nodes n1 ON n1.id = e.from_node_id
          LEFT JOIN codegraph_nodes n2 ON n2.id = e.to_node_id
          WHERE n1.id IS NULL OR n2.id IS NULL
        `)
        expect(orphanEndpoints?.c ?? 0).toBe(0)

        // 2. No tree-sitter-only edge kinds reach the DB.
        const tsKinds = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges WHERE kind IN ('yield', 'service_access')
        `)
        expect(tsKinds?.c ?? 0).toBe(0)

        // 3. No edge carries a parser-only target form. Regex imports point at
        // `module:<specifier>`; tree-sitter targets are `symbol:<name>` and
        // `service:<tag>`. Check the id (which embeds `from->to`) and both
        // endpoint columns.
        const parserTargets = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges
          WHERE id LIKE '%->module:%'
             OR id LIKE '%->symbol:%'
             OR id LIKE '%->service:%'
             OR from_node_id LIKE 'module:%'
             OR from_node_id LIKE 'symbol:%'
             OR from_node_id LIKE 'service:%'
             OR to_node_id LIKE 'module:%'
             OR to_node_id LIKE 'symbol:%'
             OR to_node_id LIKE 'service:%'
        `)
        expect(parserTargets?.c ?? 0).toBe(0)

        // Sanity: the DB rows are what repo.listAllEdges reports (both views
        // of the graph agree).
        const listedEdges = yield* repo.listAllEdges()
        expect(listedEdges.length).toBe(edgeCount)
      }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(dbLayer), Effect.scoped) as never,
    )
  })
})
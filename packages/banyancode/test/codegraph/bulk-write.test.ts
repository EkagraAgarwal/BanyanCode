/**
 * Full-build write path: what the speedup must not change, real temp repos and
 * real SQLite. Timings live in specs/banyancode/native-indexer.md; these pin the
 * behaviour they depend on.
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Storage } from "../../src/storage/index.js"
import { make as makeRepo } from "../../src/codegraph/codegraph-repo.js"
import { make as makeIndexer } from "../../src/codegraph/codegraph-indexer.js"

const withRepo = async (
  files: Record<string, string>,
  body: (input: { storage: Storage.Interface; build: Effect.Effect<unknown, unknown> }) => Effect.Effect<void, unknown>,
) => {
  const root = await mkdtemp(join(tmpdir(), "banyancode-bulk-"))
  const dbDir = await mkdtemp(join(tmpdir(), "banyancode-bulk-db-"))
  try {
    await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(root, name), content)))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* Storage.open({
            projectRoot: root,
            env: { ...process.env, BANYANCODE_PROJECT_DB_DIR: dbDir },
          })
          const indexer = yield* makeIndexer(makeRepo(storage), storage)
          yield* body({ storage, build: indexer.index({ root, force: true }) })
        }),
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    await rm(dbDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

describe("codegraph bulk writes", () => {
  test("recomputing in_degree does not rewrite the FTS index", async () => {
    await withRepo({ "a.ts": "export function alpha() { return 1 }\n" }, ({ storage, build }) =>
      Effect.gen(function* () {
        yield* build
        const ftsPages = "SELECT COUNT(*) AS pages, SUM(LENGTH(block)) AS bytes FROM codegraph_nodes_fts_data"
        const before = yield* storage.query(ftsPages)
        yield* storage.exec("UPDATE codegraph_nodes SET in_degree = in_degree + 1")
        expect(yield* storage.query(ftsPages)).toEqual(before)
      }),
    )
  })

  test("changing an indexed column still updates the FTS index", async () => {
    await withRepo({ "a.ts": "export function alpha() { return 1 }\n" }, ({ storage, build }) =>
      Effect.gen(function* () {
        yield* build
        const matches = (term: string) =>
          storage
            .query<{ c: number }>("SELECT COUNT(*) AS c FROM codegraph_nodes_fts WHERE codegraph_nodes_fts MATCH ?", [term])
            .pipe(Effect.map((rows) => rows[0]?.c ?? 0))
        expect(yield* matches("zulu")).toBe(0)
        const before = yield* matches("alpha")
        expect(before).toBeGreaterThan(0)
        yield* storage.exec("UPDATE codegraph_nodes SET code = 'zulu', name = 'zulu', signature = NULL WHERE name = 'alpha'")
        expect(yield* matches("zulu")).toBeGreaterThan(0)
        expect(yield* matches("alpha")).toBeLessThan(before)
      }),
    )
  })

  test("a build leaves the connection's cache and WAL settings at their defaults", async () => {
    await withRepo({ "a.ts": "export const a = 1\n" }, ({ storage, build }) =>
      Effect.gen(function* () {
        const pragmas = Effect.all([
          storage.query("PRAGMA cache_size"),
          storage.query("PRAGMA wal_autocheckpoint"),
        ])
        const before = yield* pragmas
        yield* build
        expect(yield* pragmas).toEqual(before)
      }),
    )
  })

  test("a member call binds by its receiver: imported namespace, then local shadow, chained receivers", async () => {
    await withRepo(
      {
        "lib.ts": "export function match() { return 1 }\nexport function run() { return 2 }\n",
        "app.ts": [
          `import * as lib from "./lib"`,
          `export function match() { return 0 }`,
          `export function run() { return 0 }`,
          `export function viaNamespace() { return lib.match() }`,
          `export function viaString(text: string) { return text.match(/x/) }`,
          `export function viaChain(box: { lib: { run(): void } }) { return box.lib.run() }`,
          ``,
        ].join("\n"),
      },
      ({ storage, build }) =>
        Effect.gen(function* () {
          yield* build
          const rows = yield* storage.query<{ caller: string; callee: string; path: string }>(
            `SELECT a.name AS caller, b.name AS callee, f.path AS path
             FROM codegraph_edges e
             JOIN codegraph_nodes a ON a.id = e.from_node_id
             JOIN codegraph_nodes b ON b.id = e.to_node_id
             JOIN codegraph_files f ON f.id = b.file_id
             WHERE e.kind = 'calls' AND a.name LIKE 'via%'`,
          )
          const targets = rows.map((row) => `${row.caller}->${row.callee}@${row.path.replace(/^.*[\\/]/, "")}`).sort()
          expect(targets).toEqual(["viaChain->run@lib.ts", "viaNamespace->match@lib.ts", "viaString->match@app.ts"])
        }),
    )
  })
})

#!/usr/bin/env bun
/**
 * Compare the TypeScript and native backends over a real tree.
 *
 *   bun native/bench/parity-real.ts <root>
 *
 * Fixture parity is not enough: the first sidecar passed every fixture and
 * panicked on this repository. Prints counts and a sample of each difference.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Storage } from "../../src/storage/index.js"
import { make as makeRepo } from "../../src/codegraph/codegraph-repo.js"
import { make as makeIndexer } from "../../src/codegraph/codegraph-indexer.js"

const root = process.argv[2]
if (!root) throw new Error("usage: bun native/bench/parity-real.ts <root>")

const collect = async (native: boolean) => {
  const dbDir = await mkdtemp(join(tmpdir(), "banyan-parity-db-"))
  process.env.BANYANCODE_PROJECT_DB_DIR = dbDir
  if (native) delete process.env.BANYANCODE_NATIVE_INDEXER
  else process.env.BANYANCODE_NATIVE_INDEXER = "off"
  const started = performance.now()
  const rows = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const storage = yield* Storage.open({ projectRoot: root, env: process.env })
        const indexer = yield* makeIndexer(makeRepo(storage), storage)
        yield* indexer.index({ root, force: true })
        const nodes = yield* storage.query<{ key: string }>(
          `SELECT f.path || '|' || n.kind || '|' || n.name || '|' || n.start_line || '|' || n.end_line AS key
           FROM codegraph_nodes n JOIN codegraph_files f ON f.id = n.file_id`,
        )
        const edges = yield* storage.query<{ key: string }>(
          `SELECT ff.path || '|' || a.kind || '|' || a.name || '|' || a.start_line || '|' || e.kind || '|' || b.kind || '|' || b.name AS key
           FROM codegraph_edges e
           JOIN codegraph_nodes a ON a.id = e.from_node_id
           JOIN codegraph_nodes b ON b.id = e.to_node_id
           JOIN codegraph_files ff ON ff.id = a.file_id`,
        )
        return { nodes: nodes.map((row) => row.key), edges: edges.map((row) => row.key) }
      }),
    ),
  )
  await rm(dbDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  return { ...rows, seconds: (performance.now() - started) / 1000 }
}

const report = (label: string, ts: readonly string[], native: readonly string[]) => {
  const left = new Set(ts)
  const right = new Set(native)
  const onlyTs = [...left].filter((key) => !right.has(key))
  const onlyNative = [...right].filter((key) => !left.has(key))
  console.log(`${label}: ts=${left.size} native=${right.size} onlyTs=${onlyTs.length} onlyNative=${onlyNative.length}`)
  for (const key of onlyTs.slice(0, 15)) console.log(`  -ts ${key}`)
  for (const key of onlyNative.slice(0, 15)) console.log(`  +native ${key}`)
}

const ts = await collect(false)
const native = await collect(true)
console.log(`seconds: ts=${ts.seconds.toFixed(1)} native=${native.seconds.toFixed(1)}`)
report("nodes", ts.nodes, native.nodes)
report("edges", ts.edges, native.edges)

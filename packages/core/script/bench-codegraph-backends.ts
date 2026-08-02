// Benchmark: time codegraph indexing under the js (default) and rust
// (BANYANCODE_CODEGRAPH_BACKEND=rust + BANYANCODE_CODEGRAPH_BIN) backends.
// Prints a small table comparing wall-clock, RSS delta, and symbol counts.
//
// Usage:
//   bun run packages/core/script/bench-codegraph-backends.ts [root]
//
// Set BANYANCODE_CODEGRAPH_BIN to the codegraph-rs binary to enable the rust
// half; otherwise the rust row is reported as "skipped".

import { Effect, Layer } from "effect"
import { Database } from "../src/database/database"
import { FSUtil } from "../src/fs-util"
import { CodegraphIndexer } from "../src/banyancode/codegraph-indexer"
import { CodegraphRustParser } from "../src/banyancode/codegraph-rust-parser"
import { defaultLayer as codegraphRepoDefaultLayer } from "../src/banyancode/codegraph-repo"
import fs from "fs/promises"
import os from "os"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const root = path.resolve(process.argv[2] ?? process.cwd())

const tmpDb = (suffix: string): string =>
  path.join(os.tmpdir(), `bench-${Date.now()}-${suffix}.sqlite`)

const buildLayer = (rustBinary: string | null) => {
  const base = CodegraphIndexer.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(codegraphRepoDefaultLayer),
  )
  return rustBinary ? base.pipe(Layer.provide(CodegraphRustParser.layerFor(rustBinary))) : base
}

const runOnce = async (label: string, rustBinary: string | null): Promise<{
  label: string
  indexed: number
  symbols: number
  ms: number
  rssDeltaMB: number
} | null> => {
  if (rustBinary === null && label === "rust") {
    console.log(`${label.padEnd(6)}  skipped (BANYANCODE_CODEGRAPH_BIN not set)`)
    return null
  }
  const dbPath = tmpDb(label)
  const dbLayer = Database.layerFromPath(dbPath)
  const serviceLayer = buildLayer(rustBinary)
  const beforeRSS = process.memoryUsage().rss
  const start = performance.now()

  type IndexResult = {
  readonly indexed: number
  readonly skipped: number
  readonly scannedFiles: number
  readonly eligibleFiles: number
  readonly symbolsIndexed: number
  readonly skippedByReason: {
    gitignored: number
    banyanignored: number
    artifact: number
    tooLarge: number
    minified: number
    tooLargeParse: number
    cached: number
    readError: number
    parseFailure: number
  }
  readonly parseErrors: ReadonlyArray<{ path: string; cause: string; indexedAt: number }>
}

const result = await Effect.runPromise(
    Effect.gen(function* () {
      const indexer = yield* CodegraphIndexer.Service
      return (yield* indexer.index({ root })) as IndexResult
    }).pipe(
      Effect.provide(serviceLayer as Layer.Layer<CodegraphIndexer.Service>),
      Effect.provide(dbLayer),
      Effect.scoped,
      Effect.catchCause((cause) => {
        console.error(`${label} failed:`, cause)
        return Effect.succeed(null as IndexResult | null)
      }),
    ),
  )

  const ms = Math.round(performance.now() - start)
  const rssDeltaMB = Math.round((process.memoryUsage().rss - beforeRSS) / (1024 * 1024))

  if (result) {
    console.log(
      `${label.padEnd(6)}  ${ms}ms  indexed=${result.indexed}  symbols=${result.symbolsIndexed}  rss+${rssDeltaMB}MB`,
    )
    await fs.rm(dbPath, { force: true })
    await fs.rm(dbPath + "-wal", { force: true })
    await fs.rm(dbPath + "-shm", { force: true })
    return { label, indexed: result.indexed, symbols: result.symbolsIndexed, ms, rssDeltaMB }
  }
  await fs.rm(dbPath, { force: true })
  await fs.rm(dbPath + "-wal", { force: true })
  await fs.rm(dbPath + "-shm", { force: true })
  return null
}

const main = async (): Promise<void> => {
  console.log(`bench-codegraph-backends root=${root}`)

  const prevEnv = process.env.BANYANCODE_CODEGRAPH_BACKEND
  const prevBin = process.env.BANYANCODE_CODEGRAPH_BIN

  const rustBinary = process.env.BANYANCODE_CODEGRAPH_BIN ?? null

  // js first
  delete process.env.BANYANCODE_CODEGRAPH_BACKEND
  const js = await runOnce("js", null)

  // rust second
  if (rustBinary) {
    process.env.BANYANCODE_CODEGRAPH_BACKEND = "rust"
    process.env.BANYANCODE_CODEGRAPH_BIN = rustBinary
    const rust = await runOnce("rust", rustBinary)
    if (js && rust) {
      const speedup = (js.ms / rust.ms).toFixed(2)
      console.log(`\nspeedup: js/rust = ${speedup}x`)
    }
  } else {
    console.log("rust    skipped (set BANYANCODE_CODEGRAPH_BIN to enable)")
  }

  if (prevEnv === undefined) delete process.env.BANYANCODE_CODEGRAPH_BACKEND
  else process.env.BANYANCODE_CODEGRAPH_BACKEND = prevEnv
  if (prevBin === undefined) delete process.env.BANYANCODE_CODEGRAPH_BIN
  else process.env.BANYANCODE_CODEGRAPH_BIN = prevBin
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
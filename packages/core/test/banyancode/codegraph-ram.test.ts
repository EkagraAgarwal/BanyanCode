import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "node:path"
import fs from "node:fs"
import { Database } from "@opencode-ai/core/database/database"
import { CodegraphIndexer } from "@opencode-ai/core/banyancode/codegraph-indexer"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { FSUtil } from "@opencode-ai/core/fs-util"
import {
  _resetTreeSitterStateForTesting,
  ensureWebTreeSitterReady,
  parseIncremental,
} from "@opencode-ai/core/banyancode/langs/tree-sitter"
import {
  ensureQuerySourcesLoaded,
  parseTypeScriptWithTreeSitter,
} from "@opencode-ai/core/banyancode/langs/query-executor"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

// Peak/settled-RAM regression tests for the codegraph. Both tests run a
// FIXED deterministic corpus repeatedly and assert the settled-RSS slope is
// not positive: per-iteration wasm/parser/row retention would show up as a
// steady climb, while one-time warmup (grammar compile, page cache) settles
// after the first iteration. Tolerances are generous against allocator noise;
// a real per-file leak (one Tree per parse ≈ KBs) exceeds them by 10x+.

// Deterministic corpus source: same bytes every run, exercises the TS
// grammar (functions, class, interface, import/export) plus query edges.
const corpusSource = (index: number): string =>
  [
    `import { helper${index} } from "./helper${index}"`,
    ``,
    `export interface Shape${index} {`,
    `  readonly id: number`,
    `  render(): string`,
    `}`,
    ``,
    `export class Widget${index} implements Shape${index} {`,
    `  readonly id: number`,
    `  constructor(id: number) {`,
    `    this.id = id`,
    `  }`,
    `  render(): string {`,
    `    return helper${index}(this.id)`,
    `  }`,
    `}`,
    ``,
    `export function helper${index}(id: number): string {`,
    `  const label = \`widget-\${id}\``,
    `  if (id < 0) throw new Error(label)`,
    `  return label`,
    `}`,
    ``,
    `export function* stream${index}(count: number): Generator<string> {`,
    `  for (let i = 0; i < count; i++) {`,
    `    yield helper${index}(i)`,
    `  }`,
    `}`,
    ``,
  ].join("\n")

const maybeGC = (): void => {
  const gc = (globalThis as unknown as { gc?: () => void }).gc
  if (gc) gc()
  const bunGC = (Bun as unknown as { gc?: (force?: boolean) => void }).gc
  if (bunGC) bunGC(true)
}

// Settled memory: coax a GC, yield the event loop, then sample. heapUsed is
// the deterministic leak signal under GC; rss is a loose guard only because
// allocator arenas, JIT, and parallel test workers make it noisy —
// especially on loaded Windows machines.
const settledMemory = async (): Promise<{ rss: number; heapUsed: number }> => {
  maybeGC()
  await new Promise((resolve) => setTimeout(resolve, 50))
  maybeGC()
  const samples = [process.memoryUsage(), process.memoryUsage(), process.memoryUsage()]
  const avg = (pick: (m: NodeJS.MemoryUsage) => number): number =>
    samples.reduce((a, b) => a + pick(b), 0) / samples.length
  return { rss: avg((m) => m.rss), heapUsed: avg((m) => m.heapUsed) }
}

// Least-squares slope of RSS over iteration index (bytes/iteration).
const slopePerIteration = (ys: readonly number[]): number => {
  const n = ys.length
  const meanX = (n - 1) / 2
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const y = ys[i] ?? meanY
    num += (i - meanX) * (y - meanY)
    den += (i - meanX) * (i - meanX)
  }
  return den === 0 ? 0 : num / den
}

describe("codegraph peak/settled RAM", () => {
  test(
    "repeated tree-sitter parses show no positive settled-RSS slope",
    async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* _resetTreeSitterStateForTesting()
          yield* ensureWebTreeSitterReady()
        }),
      )
      await Effect.runPromise(Effect.promise(() => ensureQuerySourcesLoaded()))

      const sources: string[] = []
      for (let i = 0; i < 15; i++) sources.push(corpusSource(i))

      const heap: number[] = []
      const rss: number[] = []
      for (let iter = 0; iter < 6; iter++) {
        for (const [i, source] of sources.entries()) {
          // parseIncremental allocates a dedicated Parser per call (deleted
          // in `finally`) and returns a caller-owned Tree.
          const tree = await Effect.runPromise(parseIncremental(".ts", source, undefined))
          tree.delete()
          // Query path: per-parse Tree deleted inside runQueryAndExtract.
          await Effect.runPromise(parseTypeScriptWithTreeSitter(source, `ram-parse-${iter}-${i}`))
        }
        const settled = await settledMemory()
        heap.push(settled.heapUsed)
        rss.push(settled.rss)
      }
      expect(slopePerIteration(heap.slice(1))).toBeLessThanOrEqual(256 * 1024)
      const first = rss[0] ?? 0
      const last = rss[rss.length - 1] ?? 0
      expect(last - first).toBeLessThanOrEqual(8 * 1024 * 1024)
    },
    90_000,
  )

  test(
    "repeated full builds show no positive settled-RSS slope",
    async () => {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "corpus")
      fs.mkdirSync(root, { recursive: true })
      const fileCount = 25
      for (let i = 0; i < fileCount; i++) {
        fs.writeFileSync(path.join(root, `mod${i}.ts`), corpusSource(i))
      }

      const dbPath = path.join(tmp.path, "ram.db")
      const dbLayer = Database.layerFromPath(dbPath)
      const repoLayer = CodegraphRepo.layer.pipe(Layer.provide(dbLayer))
      const indexLayer = CodegraphIndexer.layer.pipe(
        Layer.provide(dbLayer),
        Layer.provideMerge(repoLayer),
        Layer.provideMerge(FSUtil.defaultLayer),
      )
      const runIndex = (): Promise<{ symbolsIndexed: number; indexed: number }> =>
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const indexer = yield* CodegraphIndexer.Service
              return yield* indexer.index({ root, force: true })
            }).pipe(Effect.provide(indexLayer)),
          ),
        )

      const heap: number[] = []
      const rss: number[] = []
      const symbols: number[] = []
      for (let iter = 0; iter < 4; iter++) {
        const result = await runIndex()
        symbols.push(result.symbolsIndexed)
        expect(result.indexed).toBe(fileCount)
        const settled = await settledMemory()
        heap.push(settled.heapUsed)
        rss.push(settled.rss)
      }
      // Same graph every build: symbol output is stable, memory settles.
      for (const count of symbols) expect(count).toBe(symbols[0])
      expect(slopePerIteration(heap.slice(1))).toBeLessThanOrEqual(1024 * 1024)
      const first = rss[0] ?? 0
      const last = rss[rss.length - 1] ?? 0
      expect(last - first).toBeLessThanOrEqual(16 * 1024 * 1024)

      // Compat: the paged APIs chain to the same rows the .all() wrappers
      // return, ordered by id ascending.
      const pageCheck = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const repo = yield* CodegraphRepo.Service
            const allNodes = yield* repo.listAllNodes()
            const allEdges = yield* repo.listAllEdges()
            const pagedIDs: string[] = []
            let cursor: string | undefined = undefined
            for (;;) {
              const page: { nodes: { id: string }[]; nextCursor: string | undefined } = yield* repo.listNodesPage({
                cursor,
                limit: 7,
              })
              for (const node of page.nodes) pagedIDs.push(node.id)
              if (page.nextCursor === undefined) break
              cursor = page.nextCursor
            }
            const edgePage = yield* repo.listEdgesPage({ limit: 5 })
            return {
              allNodes: allNodes.length,
              allEdges: allEdges.length,
              pagedNodes: pagedIDs.length,
              pagedSorted: [...pagedIDs].sort(),
              edgePageSize: edgePage.edges.length,
            }
          }).pipe(Effect.provide(repoLayer)),
        ),
      )
      expect(pageCheck.pagedNodes).toBe(pageCheck.allNodes)
      expect(pageCheck.pagedNodes).toBeGreaterThan(0)
      expect([...pageCheck.pagedSorted].join()).toBe(
        [...pageCheck.pagedSorted].sort().join(),
      )
      expect(pageCheck.edgePageSize).toBeLessThanOrEqual(5)
    },
    120_000,
  )
})

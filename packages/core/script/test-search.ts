/**
 * Manual CLI test for the Search service.
 * Indexes the real codebase and runs search queries.
 *
 * Run with: bun run packages/core/script/test-search.ts
 */

import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphIndexer } from "@opencode-ai/core/banyancode/codegraph-indexer"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Search from "../src/banyancode/search"
import type { SearchMode } from "../src/banyancode/search/search"
import path from "path"

// Use a temp DB for testing
const testDbPath = path.join(
  process.env.TEMP ?? "/tmp",
  "banyancode-search-test.db"
)

async function main() {
  console.log("=== BanyanCode Search CLI Test ===\n")
  console.log(`DB path: ${testDbPath}`)
  console.log(`Workspace: ${process.cwd()}\n`)

  const dbLayer = Database.layerFromPath(testDbPath)

  const startTime = Date.now()

  await Effect.runPromise(
    Effect.gen(function* () {
      // Initialize DB and apply migrations
      console.log("Initializing database...")
      const { db } = yield* Database.Service
      yield* DatabaseMigration.apply(db)

      const indexer = yield* CodegraphIndexer.Service
      const repo = yield* CodegraphRepo.Service

      // Check if already indexed
      const existingNodes = yield* repo.countNodes()
      if (existingNodes > 0) {
        console.log(`Already indexed: ${existingNodes} nodes`)
      } else {
        console.log("Indexing codebase...")
        yield* indexer.index({
          root: process.cwd(),
          force: false,
          maxFileSizeBytes: 512 * 1024,
        })
      }

      const totalNodes = yield* repo.countNodes()
      const totalFiles = yield* repo.countFiles()
      console.log(`Total: ${totalNodes} nodes, ${totalFiles} files\n`)

      const search = yield* Search.Service

      // Test queries
      const queries = [
        { q: "build", modes: ["BM25", "Fuzzy", "Prefix"] as const, label: "build (BM25+Fuzzy+Prefix)" },
        { q: "CGBS", modes: ["CamelCase"] as const, label: "CGBS (CamelCase)" },
        { q: "codegraph_build", modes: ["snake_case"] as const, label: "codegraph_build (snake_case)" },
        { q: "Mem0", modes: ["Fuzzy", "BM25"] as const, label: "Mem0 (Fuzzy+BM25)" },
      ]

      for (const { q, modes, label } of queries) {
        const queryStart = Date.now()
        const results = yield* search.search(q, { modes: [...modes], limit: 5 })
        const queryTime = Date.now() - queryStart

        console.log(`\n--- Query: "${q}" [${label}] ---`)
        console.log(`Time: ${queryTime}ms`)
        console.log(`Results: ${results.length}`)

        for (let i = 0; i < Math.min(5, results.length); i++) {
          const r = results[i]
          const signals: string[] = []
          if (r.signals.exact) signals.push("exact")
          if (r.signals.prefix) signals.push("prefix")
          if (r.signals.camelCase) signals.push("camelCase")
          if (r.signals.snake_case) signals.push("snake_case")
          if (r.signals.fuzzy !== undefined) signals.push(`fuzzy(${r.signals.fuzzy})`)
          if (r.signals.bm25 !== undefined) signals.push(`bm25(${r.signals.bm25.toFixed(2)})`)
          if (r.signals.graph !== undefined && r.signals.graph > 0) signals.push(`graph(${r.signals.graph})`)
          if (r.signals.qualified) signals.push("qualified")

          console.log(
            `  ${i + 1}. [${r.score.toFixed(2)}] ${r.node.name} (${r.node.kind}) [${signals.join(", ")}]`
          )
        }
      }

      // Performance test: run same query 5 times and report median
      console.log("\n--- Performance Test ---")
      const perfQuery = "build"
      const perfTimes: number[] = []
      const perfModes: SearchMode[] = ["BM25", "Fuzzy", "Prefix"]
      for (let i = 0; i < 5; i++) {
        const t = Date.now()
        yield* search.search(perfQuery, { modes: perfModes, limit: 50 })
        perfTimes.push(Date.now() - t)
      }
      perfTimes.sort((a, b) => a - b)
      const median = perfTimes[Math.floor(perfTimes.length / 2)]
      console.log(`Median query time for "${perfQuery}": ${median}ms`)

      const totalTime = Date.now() - startTime
      console.log(`\nTotal time: ${totalTime}ms`)
    }).pipe(
      Effect.provide(Search.defaultLayer),
      Effect.provide(CodegraphIndexer.defaultLayer),
      Effect.provide(CodegraphRepo.defaultLayer),
      Effect.provide(FSUtil.defaultLayer),
      Effect.provide(dbLayer),
      Effect.scoped,
    ),
  )
}

main().catch(console.error)

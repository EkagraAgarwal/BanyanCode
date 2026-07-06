#!/usr/bin/env bun

// Run with: bun run packages/core/script/test-repo-intel.ts
// Requires BANYANCODE_ENABLE=1 (set below)

process.env.BANYANCODE_ENABLE = "1"

import { Effect } from "effect"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../src/banyancode/codegraph-repo"
import {
  RepositoryIntelligence,
  defaultLayer as repositoryIntelligenceDefaultLayer,
} from "../src/banyancode/repository-intelligence"
import { CodegraphBuildService, defaultLayer as codegraphBuildServiceDefaultLayer } from "../src/banyancode/codegraph-build-service"
import { FSUtil } from "../src/fs-util"
import path from "path"

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "../../..")
const INDEX_ROOT = path.join(WORKSPACE_ROOT, "packages/core/src/banyancode")

async function main() {
  const dbPath = Database.path()
  console.log(`Database: ${dbPath}`)

  const dbLayer = Database.layerFromPath(dbPath)

  console.log(`\nIndexing: ${INDEX_ROOT}`)
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* DatabaseMigration.apply(db)
      const buildService = yield* CodegraphBuildService.Service
      yield* buildService.start({ root: INDEX_ROOT, force: true })
    }).pipe(
      Effect.provide(codegraphBuildServiceDefaultLayer),
      Effect.provide(FSUtil.defaultLayer),
      Effect.provide(dbLayer),
      Effect.scoped,
    ),
  )

  console.log("Indexing complete.\n")

  await Effect.runPromise(
    Effect.gen(function* () {
      const ri = yield* RepositoryIntelligence.Service
      const repo = yield* CodegraphRepo.Service

      console.log("=== symbols ===")
      const sym1 = yield* ri.symbols({ query: "findSymbol" })
      console.log(`symbols({ query: "findSymbol" }) => ${sym1.length} results`)
      for (const n of sym1.slice(0, 3)) {
        console.log(`  - ${n.kind}: ${n.name} (fileID: ${n.fileID})`)
      }

      console.log("\n=== query ===")
      const ctx = yield* ri.query({ query: "CodegraphRepo" })
      console.log(`query({ query: "CodegraphRepo" }) => ${ctx.symbols.length} symbols, ${ctx.graph.edges.length} edges`)

      console.log("\n=== tests ===")
      const tests1 = yield* ri.tests({ symbol: "putNode" })
      console.log(`tests({ symbol: "putNode" }) => ${tests1.tests.length} test nodes`)

      console.log("\n=== relationships ===")
      const symNode = (yield* repo.searchNodes({ name: "findSymbol" }))[0]
      if (symNode) {
        const related = yield* ri.relationships({ nodeID: symNode.id, depth: 1 })
        console.log(`relationships({ nodeID: "${symNode.id}", depth: 1 }) => ${related.length} related nodes`)
        for (const n of related.slice(0, 5)) {
          console.log(`  - ${n.kind}: ${n.name}`)
        }
      }

      console.log("\n=== impact ===")
      const allFiles = yield* repo.listAllFiles()
      if (allFiles.length > 0) {
        const samplePath = allFiles[0].path
        const slc = yield* ri.impact({ path: samplePath })
        console.log(`impact({ path: "${samplePath}" }) => summary: ${slc.summary}`)
        console.log(`  importantSymbols: ${slc.importantSymbols.length}`)
      }

      console.log("\n=== trace ===")
      const allNodes = yield* repo.listAllNodes()
      const fnNodes = allNodes.filter((n) => n.kind === "function" && n.name.length > 3)
      if (fnNodes.length > 0) {
        const target = fnNodes[0]
        const slc = yield* ri.trace({ symbol: target.name, depth: 2 })
        console.log(`trace({ symbol: "${target.name}", depth: 2 }) => summary: ${slc.summary}`)
      }

      console.log("\n=== findOwner ===")
      const owner = yield* ri.findOwner({ path: "packages/core/src/banyancode" })
      console.log(`findOwner => ${JSON.stringify(owner)}`)

      console.log("\n=== Graph Stats ===")
      const nodeCount = yield* repo.countNodes()
      const edgeCount = yield* repo.countEdges()
      const fileCount = yield* repo.countFiles()
      console.log(`Total: ${nodeCount} nodes, ${edgeCount} edges, ${fileCount} files`)
    }).pipe(
      Effect.provide(repositoryIntelligenceDefaultLayer),
      Effect.provide(codegraphRepoDefaultLayer),
      Effect.provide(dbLayer),
      Effect.scoped,
    ),
  )

  console.log("\n✅ All functions executed successfully.")
}

main().catch((err) => {
  console.error("Script error:", err)
  process.exit(1)
})
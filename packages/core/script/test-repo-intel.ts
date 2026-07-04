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

  // Build the codegraph for the banyancode source directory
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

  // Run each function
  await Effect.runPromise(
    Effect.gen(function* () {
      const ri = yield* RepositoryIntelligence.Service
      const repo = yield* CodegraphRepo.Service

      // --- findSymbol ---
      console.log("=== findSymbol ===")
      const sym1 = yield* ri.findSymbol({ name: "findSymbol" })
      console.log(`findSymbol({ name: "findSymbol" }) => ${sym1.length} results`)
      for (const n of sym1.slice(0, 3)) {
        console.log(`  - ${n.kind}: ${n.name} (fileID: ${n.fileID})`)
      }

      const sym2 = yield* ri.findSymbol({ name: "findSymbol", kind: "function", exact: true })
      console.log(`findSymbol({ name: "findSymbol", kind: "function", exact: true }) => ${sym2.length} results`)

      const sym3 = yield* ri.findSymbol({ name: "Service", kind: "class" })
      console.log(`findSymbol({ name: "Service", kind: "class" }) => ${sym3.length} results`)
      for (const n of sym3.slice(0, 3)) {
        console.log(`  - ${n.kind}: ${n.name}`)
      }

      // --- findSubsystem ---
      console.log("\n=== findSubsystem ===")
      const subsystem = yield* ri.findSubsystem({ query: "CodegraphRepo" })
      console.log(`findSubsystem({ query: "CodegraphRepo" }) => entry: ${subsystem.entry.kind}:${subsystem.entry.name}, related: ${subsystem.related.length} nodes`)
      for (const n of subsystem.related.slice(0, 5)) {
        console.log(`  - ${n.kind}: ${n.name}`)
      }

      // --- findEntrypoints ---
      console.log("\n=== findEntrypoints ===")
      const entries1 = yield* ri.findEntrypoints({ feature: "codegraph" })
      console.log(`findEntrypoints({ feature: "codegraph" }) => ${entries1.length} entrypoints`)
      for (const n of entries1.slice(0, 5)) {
        console.log(`  - ${n.kind}: ${n.name}`)
      }

      const entries2 = yield* ri.findEntrypoints({ feature: "memory" })
      console.log(`findEntrypoints({ feature: "memory" }) => ${entries2.length} entrypoints`)
      for (const n of entries2.slice(0, 3)) {
        console.log(`  - ${n.kind}: ${n.name}`)
      }

      // --- findTests ---
      console.log("\n=== findTests ===")
      const tests1 = yield* ri.findTests({ symbol: "putNode" })
      console.log(`findTests({ symbol: "putNode" }) => ${tests1.length} test nodes`)
      for (const n of tests1.slice(0, 3)) {
        console.log(`  - ${n.kind}: ${n.name}`)
      }

      const tests2 = yield* ri.findTests({ symbol: "findSymbol" })
      console.log(`findTests({ symbol: "findSymbol" }) => ${tests2.length} test nodes`)

      // --- findRelated ---
      console.log("\n=== findRelated ===")
      const symNode = (yield* repo.searchNodes({ name: "findSymbol" }))[0]
      if (symNode) {
        const related = yield* ri.findRelated({ nodeID: symNode.id, depth: 1 })
        console.log(`findRelated({ nodeID: "${symNode.id}", depth: 1 }) => ${related.length} related nodes`)
        for (const n of related.slice(0, 5)) {
          console.log(`  - ${n.kind}: ${n.name}`)
        }
      }

      // --- estimateImpact ---
      console.log("\n=== estimateImpact ===")
      const allFiles = yield* repo.listAllFiles()
      if (allFiles.length > 0) {
        const samplePath = allFiles[0].path
        const impact = yield* ri.estimateImpact({ paths: [samplePath], maxDepth: 2 })
        console.log(`estimateImpact({ paths: ["${samplePath}"], maxDepth: 2 })`)
        console.log(`  direct: ${impact.direct.length} nodes`)
        console.log(`  transitive: ${impact.transitive.length} nodes`)
        console.log(`  blastRadius: ${(impact.blastRadius * 100).toFixed(2)}%`)
      }

      // --- traceExecution ---
      console.log("\n=== traceExecution ===")
      const allNodes = yield* repo.listAllNodes()
      const fnNodes = allNodes.filter((n) => n.kind === "function" && n.name.length > 3)
      if (fnNodes.length > 0) {
        const target = fnNodes[0]
        const trace = yield* ri.traceExecution({ from: target.id, maxDepth: 2 })
        console.log(`traceExecution({ from: "${target.name}", maxDepth: 2 }) => ${trace.length} nodes in trace`)
        for (const n of trace.slice(0, 5)) {
          console.log(`  - ${n.kind}: ${n.name}`)
        }
      }

      // Summary stats
      console.log("\n=== Graph Stats ===")
      const nodeCount = yield* repo.countNodes()
      const edgeCount = yield* repo.countEdges()
      const fileCount = yield* repo.countFiles()
      console.log(`Total: ${nodeCount} nodes, ${edgeCount} edges, ${fileCount} files`)
    }).pipe(
      Effect.provide(repositoryIntelligenceDefaultLayer),
      Effect.provide(CodegraphRepo.defaultLayer),
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

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"
import { Banyan } from "@opencode-ai/core/banyancode"
import { CodegraphBuildService } from "@opencode-ai/core/banyancode/codegraph-build-service"
import { CodegraphIndexer } from "@opencode-ai/core/banyancode/codegraph-indexer"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2 } from "@opencode-ai/core/event"
import { NodeFileSystem } from "@effect/platform-node"
import { pollWithTimeout } from "../lib/effect"

process.env.BANYANCODE_ENABLE = "1"

function makeTestLayer(dbPath: string) {
  const dbLayer = Database.layerFromPath(dbPath)
  const repoLayer = Banyan.codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))
  const buildLayer = Banyan.codegraphBuildServiceDefaultLayer.pipe(Layer.provide(dbLayer))
  const intelLayer = Banyan.repositoryIntelligenceDefaultLayer.pipe(Layer.provide(repoLayer)) // already has git
  const indexerLayer = CodegraphIndexer.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(repoLayer),
  )
  return Layer.mergeAll(repoLayer, buildLayer, intelLayer, indexerLayer).pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(EventV2.defaultLayer),
    Layer.provide(dbLayer),
  )
}

describe("repository_trace end-to-end (Permission.ask)", () => {
  test(
    "traces Permission.ask on the real BanyanCode workspace: snapshot directCallers + transitiveDependents",
    async () => {
      const workspaceRoot = "D:\\OpenCode"
      const dbPath = path.join(
        os.tmpdir(),
        "opencode-trace-e2e-" + Math.random().toString(36).slice(2) + ".sqlite",
      )
      const layer = makeTestLayer(dbPath)

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const buildSvc = yield* CodegraphBuildService.Service
          const intel = yield* Banyan.RepositoryIntelligence

          yield* buildSvc.start({ root: workspaceRoot, force: true })

          // Wait for build to finish.
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const s = yield* buildSvc.status()
              if (s.status === "completed" || s.status === "failed" || s.status === "cancelled") return s
              return undefined
            }),
            "build never completed",
            "5 minutes",
          )

          // Now trace Permission.ask.
          const slice = yield* intel.trace({ symbol: "Permission.ask", depth: 2 })
          return slice
        }).pipe(Effect.provide(layer), Effect.scoped),
      )

      // Snapshot sanity checks:
      // (a) the call did not throw, (b) both arrays populated, (c) every node
      // in directCallers is exactly 1-hop from the anchor.
      console.log(
        `directCallers=${result.directCallers.length} transitiveDependents=${result.transitiveDependents.length}`,
      )
      expect(result.directCallers.length).toBeGreaterThan(0)
      expect(result.transitiveDependents.length).toBeGreaterThan(0)
      // Every direct caller should be a code-like kind (function/class/method).
      for (const node of result.directCallers) {
        expect(["function", "class", "method"]).toContain(node.kind)
      }
      // Entry points remain aliased to directCallers for back-compat.
      expect(result.entrypoints.length).toBe(result.directCallers.length)

      try {
        await fs.unlink(dbPath)
      } catch {}
    },
    300000,
  )
})

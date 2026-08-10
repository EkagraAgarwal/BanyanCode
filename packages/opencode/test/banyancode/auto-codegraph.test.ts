import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { SystemPrompt } from "@/session/system"
import { Skill } from "@/skill"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Flag } from "@opencode-ai/core/flag/flag"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Database } from "@opencode-ai/core/database/database"
import { Banyan } from "@opencode-ai/core/banyancode"
import { CODEGRAPH_SCHEMA_VERSION } from "@opencode-ai/core/banyancode/codegraph-repo"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"
import path from "path"

const it = testEffect(
  Layer.mergeAll(
    SystemPrompt.defaultLayer,
    Skill.defaultLayer,
    FSUtil.defaultLayer,
    LocationServiceMap.layer,
  ),
)

// Phase A: SystemPrompt.defaultLayer + a CodegraphBootstrap wired to a
// tmpdir DB. The real indexer is never started here — the bootstrap's
// `status()` path only reads the meta row, so seeding it directly is
// sufficient to flip the rendered Graph state line.
const buildBootstrapSystemLayer = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
  return Layer.mergeAll(
    SystemPrompt.defaultLayer,
    Skill.defaultLayer,
    FSUtil.defaultLayer,
    LocationServiceMap.layer,
    Banyan.CodegraphSystemSourceNS.defaultLayer,
    Banyan.codegraphBootstrapLayer.pipe(
      Layer.provide(Banyan.codegraphReadinessLayer),
      Layer.provide(Banyan.codegraphBuildServiceLayer),
      Layer.provide(Banyan.codegraphIndexerLayer.pipe(Layer.provide(dbLayer))),
      Layer.provideMerge(Banyan.codegraphRepoLayer.pipe(Layer.provide(dbLayer))),
      Layer.provideMerge(FSUtil.defaultLayer),
    ),
  )
}

describe("PR C: SystemPrompt.codegraph auto-tools policy", () => {
  it.effect("returns undefined when BanyanCode is disabled", () =>
    Effect.gen(function* () {
      const svc = yield* SystemPrompt.Service
      const original = process.env.BANYANCODE_ENABLE
      process.env.BANYANCODE_ENABLE = "0"
      try {
        const block = yield* svc.codegraph()
        expect(block).toBeUndefined()
      } finally {
        if (original === undefined) delete process.env.BANYANCODE_ENABLE
        else process.env.BANYANCODE_ENABLE = original
      }
    }),
  )

  // The V1 layer here does NOT provide Banyan.CodegraphSystemSource, so
  // SystemPrompt.codegraph() falls back to `legacyCodegraphPolicy()` in
  // packages/opencode/src/session/system.ts. That fallback intentionally
  // ships the same header (`## Codegraph-first search policy`) the V2 source
  // emits so V1 always carries at least the policy section. The per-tool
  // catalog is added by tests / calling layers that provide the V2 source
  // (see `codegraph-system-source.test.ts`).
  it.effect("returns the codegraph block when BanyanCode is enabled", () =>
    Effect.gen(function* () {
      const svc = yield* SystemPrompt.Service
      const original = process.env.BANYANCODE_ENABLE
      delete process.env.BANYANCODE_ENABLE
      try {
        const block = yield* svc.codegraph()
        expect(block).toBeDefined()
        expect(block).toContain("codegraph")
        expect(block).toContain("code_find")
        expect(block).toContain("repository_query")
      } finally {
        if (original === undefined) delete process.env.BANYANCODE_ENABLE
        else process.env.BANYANCODE_ENABLE = original
      }
    }),
  )

  // Phase A: when the bootstrap service IS in scope, codegraph() reads the
  // graph state and renders a "Graph state:" line into the policy block.
  // Missing graph → the block still renders and does not throw; a seeded
  // meta row → the block carries the ready marker with the symbol count.
  test("codegraph() renders the Graph state line when the bootstrap service is provided", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "bootstrap.db")
    const layer = buildBootstrapSystemLayer(dbPath)

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SystemPrompt.Service
          const missing = yield* svc.codegraph()
          expect(missing).toBeDefined()
          expect(missing).toContain("Repository intelligence is the canonical interface")
          expect(missing).toContain("Graph state: missing")
          expect(missing).not.toContain("Graph state: ready")

          const repo = yield* Banyan.CodegraphRepo
          yield* repo.setMeta({
            id: "singleton",
            graphBuiltAt: Date.now(),
            graphVersion: 1,
            graphCoverage: 1,
            totalFiles: 1204,
            totalNodes: 1000,
            totalEdges: 500,
            schemaVersion: CODEGRAPH_SCHEMA_VERSION,
            indexedRoot: tmp.path,
          })

          const ready = yield* svc.codegraph()
          expect(ready).toBeDefined()
          expect(ready).toContain("Graph state: ready (1,204 symbols)")
          expect(ready).toContain("code_find")
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
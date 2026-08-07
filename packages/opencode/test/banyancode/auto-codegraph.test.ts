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

  // The V1 layer here uses `SystemPrompt.defaultLayer`, which now mounts
  // `CodegraphSystemSource`. With no `tools` and no bootstrap in scope,
  // `load(undefined)` pins to exactly `POLICY_TEXT`, so the fallback branch
  // in `SystemPrompt.codegraph()` ships the same header (`## Codegraph-first
  // search policy`) and the per-tool catalog is added by tests / calling
  // layers that pass the resolved tool set (see `codegraph-system-source.test.ts`).
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
          expect(missing).toContain("Codegraph-first search policy")
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

  // Regression for unify-runtime-root: the V1 session prompt composition
  // must carry BOTH the dynamic tool guide (rendered from the materialized
  // tool set the model sees) AND the graph state. `SystemPrompt.defaultLayer`
  // mounts `CodegraphSystemSource`, and the AppLayer mounts the root-bound
  // `CodegraphBootstrap`, so `codegraph(tools)` renders the per-tool catalog
  // section in addition to the policy + Graph state line.
  test("codegraph(tools) renders the dynamic tool guide AND graph state (V1 AppLayer composition)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "bootstrap-tools.db")
    const layer = buildBootstrapSystemLayer(dbPath)

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SystemPrompt.Service
          const tools = {
            code_find: { description: "Look up a symbol or file in the code graph" },
            repository_query: { description: "Run a semantic query over the repository" },
            banyan_repo_map: { description: "Token-budgeted outline of the workspace" },
          } as unknown as Record<string, { description?: string }>

          const block = yield* svc.codegraph(tools as never)
          expect(block).toBeDefined()
          // Dynamic tool guide: per-tool descriptions rendered into the prompt.
          expect(block).toContain("BanyanCode tool guide")
          expect(block).toContain("Look up a symbol or file in the code graph")
          expect(block).toContain("Token-budgeted outline of the workspace")
          // Static policy + graph state still present.
          expect(block).toContain("Codegraph-first search policy")
          expect(block).toContain("Graph state:")
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})

describe("A1: per-session codegraph block freeze (prompt-cache stability)", () => {
  const TOOLS = {
    code_find: { description: "Look up a symbol or file in the code graph" },
    repository_query: { description: "Run a semantic query over the repository" },
    banyan_repo_map: { description: "Token-budgeted outline of the workspace" },
  } as unknown as Record<string, { description?: string }>

  // The system prompt is rebuilt on every step (prompt.ts loop); before the
  // freeze, the "Graph state:" line was read LIVE from the bootstrap on each
  // render, so a background build flipping missing→ready(N) (or the symbol
  // count changing as files are edited) mutated the request prefix and forced
  // a full provider cache miss on every step. This test pins the freeze:
  // with a sessionID, the first render wins and later steps return
  // byte-identical text even as the graph state changes underneath.
  test("rendered block is byte-identical across steps of one session despite graph-state flips", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "prefix-freeze.db")
    const layer = buildBootstrapSystemLayer(dbPath)

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SystemPrompt.Service
          const sessionID = "ses_prefix_freeze"

          const first = yield* svc.codegraph(TOOLS as never, sessionID)
          expect(first).toBeDefined()
          expect(first).toContain("Graph state: missing")

          // Between steps the graph flips to ready with a different symbol
          // count (the background indexer finished / re-indexed).
          const repo = yield* Banyan.CodegraphRepo
          yield* repo.setMeta({
            id: "singleton",
            graphBuiltAt: Date.now(),
            graphVersion: 1,
            graphCoverage: 1,
            totalFiles: 20462,
            totalNodes: 20000,
            totalEdges: 10000,
            schemaVersion: CODEGRAPH_SCHEMA_VERSION,
            indexedRoot: tmp.path,
          })

          const second = yield* svc.codegraph(TOOLS as never, sessionID)
          // Byte-identical: the freeze holds within a session.
          expect(second).toEqual(first)
          expect(second).toContain("Graph state: missing")

          // A DIFFERENT session re-renders live — the freeze is per-session.
          const other = yield* svc.codegraph(TOOLS as never, "ses_other")
          expect(other).toContain("Graph state: ready (20,462 symbols)")
          expect(other).not.toEqual(first)

          // A changed tool set invalidates the cache even for the same session.
          const changedTools = {
            ...TOOLS,
            code_find: { description: "Changed description for cache invalidation" },
          } as unknown as Record<string, { description?: string }>
          const changed = yield* svc.codegraph(changedTools as never, sessionID)
          expect(changed).toContain("Changed description for cache invalidation")
          expect(changed).not.toEqual(first)
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
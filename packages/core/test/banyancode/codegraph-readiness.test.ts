import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { CodegraphIndexer } from "@opencode-ai/core/banyancode/codegraph-indexer"
import { CodegraphReadiness } from "@opencode-ai/core/banyancode/codegraph-readiness"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "node:path"

const idleIndexer = Layer.succeed(
  CodegraphIndexer.Service,
  CodegraphIndexer.Service.of({
    index: () =>
      Effect.succeed({
        indexed: 1,
        skipped: 0,
        scannedFiles: 1,
        eligibleFiles: 1,
        symbolsIndexed: 0,
        skippedByReason: {
          gitignored: 0,
          banyanignored: 0,
          artifact: 0,
          tooLarge: 0,
          minified: 0,
          tooLargeParse: 0,
          cached: 0,
          readError: 0,
          parseFailure: 0,
        },
        parseErrors: [],
      }),
    applyChanges: () => Effect.succeed({ indexed: 0, removed: 0, skipped: 0, parseErrors: [] }),
    indexFiles: () => Effect.succeed({ indexed: 0, skipped: 0, parseErrors: [] }),
    removeFiles: () => Effect.void,
    cancel: () => Effect.void,
  }),
)

describe("CodegraphReadiness", () => {
  test("status() reports a structured ReadinessResult with reason and autoBuilt fields", async () => {
    await using tmp = await tmpdir()
    // Layer is constructed using the readiness service's own `layer` (not
    // `defaultLayer`) so we can wire deps explicitly. The `codegraph-build-service`
    // and `codegraph-staleness` integration tests already exercise the full
    // build + auto-update + readiness paths end-to-end against a real DB.
    const dbPath = path.join(tmp.path, "readiness-empty.db")
    const { Database } = await import("@opencode-ai/core/database/database")
    const { CodegraphRepo, layer: codegraphRepoLayer } = await import(
      "@opencode-ai/core/banyancode/codegraph-repo"
    )
    const { CodegraphBuildService, layer: codegraphBuildLayer } = await import(
      "@opencode-ai/core/banyancode/codegraph-build-service"
    )

    const layer = CodegraphReadiness.layer.pipe(
      Layer.provide(codegraphBuildLayer),
      Layer.provide(idleIndexer),
      Layer.provide(codegraphRepoLayer.pipe(Layer.provide(Database.layerFromPath(dbPath)))),
      Layer.provide(FSUtil.defaultLayer),
    )

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* CodegraphReadiness.Service
          return yield* svc.status()
        }).pipe(Effect.provide(layer)),
      ),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(typeof exit.value.reason).toBe("string")
      expect(["ready", "missing", "stale", "building", "failed"]).toContain(exit.value.reason)
      expect(typeof exit.value.autoBuilt).toBe("boolean")
    }
  })
})

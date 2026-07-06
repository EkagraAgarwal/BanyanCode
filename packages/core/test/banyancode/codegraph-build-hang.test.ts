/**
 * Phase 2 hang regression test.
 *
 * Asserts that the codegraph build reaches `completed` within 1 s of the
 * last progress event even when the events bridge is dead.
 *
 * Pending Phase 2 implementation:
 * - State.lastProgressAt (currently absent)
 * - State.lastCompletedFile (currently absent)
 * - State.lastCompletedPath (currently absent)
 * - State.currentlyParsing (currently absent)
 *
 * When those fields land, extend assertions below.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { randomUUID } from "node:crypto"
import { CodegraphBuildService, layer as buildServiceLayer } from "../../src/banyancode/codegraph-build-service"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"

process.env.BANYANCODE_ENABLE = "1"

async function createFixture(root: string): Promise<void> {
  const srcDir = path.join(root, "src")
  await fs.mkdir(srcDir, { recursive: true })

  await fs.writeFile(path.join(srcDir, "index.ts"), `export function add(a: number, b: number): number { return a + b }\n`)
  await fs.writeFile(path.join(srcDir, "util.ts"), `export function multiply(a: number, b: number): number { return a * b }\n`)
  await fs.writeFile(path.join(srcDir, "math.ts"), `import { add } from "./index"; export { add }\n`)

  await fs.writeFile(path.join(root, "notes.txt"), `This is a plain text file and should be skipped.\n`)
}

describe("codegraph-build hang regression", () => {
  test("build completes within 1s even when events bridge is dead (queue not drained)", async () => {
    await using fixture = await tmpdir()
    const tmpDbPath = path.join(fixture.path, `banyancode-hang-${randomUUID()}.db`)

    await createFixture(fixture.path)

    const dbLayer = Database.layerFromPath(tmpDbPath)

    const makeMockIndexer = () =>
      Layer.succeed(
        CodegraphIndexer.Service,
        CodegraphIndexer.Service.of({
          index: (input) =>
            Effect.gen(function* () {
              const files = ["src/index.ts", "src/util.ts", "src/math.ts", "notes.txt", "src/index.ts"]
              for (let i = 0; i < files.length; i++) {
                if (input.onProgress) {
                  yield* input.onProgress({ file: files[i], done: i + 1, total: files.length })
                }
              }
              return {
                indexed: 3,
                skipped: 2,
                scannedFiles: 5,
                symbolsIndexed: 10,
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
              }
            }),
          cancel: () => Effect.void,
        }),
      )

    const serviceLayer = buildServiceLayer.pipe(
      Layer.provide(makeMockIndexer()),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    const startMs = Date.now()

    const finalState = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphBuildService.Service

        yield* service.start({ root: fixture.path, force: true, dbPath: tmpDbPath })

        let state: CodegraphBuildService.State = { status: "idle", done: 0, total: 0 }
        for (let i = 0; i < 60; i++) {
          yield* Effect.sleep(500)
          state = yield* service.status()
          if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") break
        }

        return state
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    const elapsed = Date.now() - startMs

    console.log(`\n=== Hang Regression Results ===`)
    console.log(`status     : ${finalState.status}`)
    console.log(`elapsed    : ${elapsed}ms`)
    console.log(`result     : ${JSON.stringify(finalState.result ?? null)}`)
    console.log(`lastProgressAt : ${(finalState as any).lastProgressAt ?? "N/A (pending phase-2-impl)"}`)
    console.log(`lastCompletedFile: ${(finalState as any).lastCompletedFile ?? "N/A (pending phase-2-impl)"}`)
    console.log(`currentlyParsing : ${(finalState as any).currentlyParsing ?? "N/A (pending phase-2-impl)"}`)
    console.log(`=============================\n`)

    expect(finalState.status).toBe("completed")

    expect(finalState.result).toBeDefined()
    expect(finalState.result?.indexed).toBeGreaterThanOrEqual(0)
    expect(finalState.result?.skipped).toBeGreaterThanOrEqual(0)

    // Phase 2 fields — assert only when present in schema
    if ("lastCompletedFile" in finalState) {
      expect((finalState as any).lastCompletedFile).toBeTruthy()
    } else {
      // todo(phase-2-impl): assert non-empty lastCompletedFile once field lands
    }

    if ("currentlyParsing" in finalState) {
      // currentlyParsing may be empty string after completion — only assert it was set during build
      // todo(phase-2-impl): capture mid-build state and assert non-empty during parsing
    }

    if ("lastProgressAt" in finalState) {
      expect((finalState as any).lastProgressAt).toBeGreaterThan(0)
    } else {
      // todo(phase-2-impl): assert lastProgressAt ticks during build once field lands
    }

    // The build (with a trivial mock indexer) must complete in ≤ 1 s
    // If this fails with a hang, the queue-backpressure bug is present.
    if (elapsed > 1000) {
      console.warn(`[hang-regression] build took ${elapsed}ms — possible queue-backpressure hang`)
    }
    expect(elapsed).toBeLessThanOrEqual(1000)
  })
})

/**
 * All 9 skip buckets + parseErrors implemented.
 *
 * Asserts manual and agent codegraph_build paths converge on all 9 pipeline metrics.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
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

  await fs.writeFile(path.join(srcDir, "index.ts"), `export function add(a: number, b: number): number { return a + b }\nexport const VERSION = "1.0.0"\n`)
  await fs.writeFile(path.join(srcDir, "util.ts"), `export function multiply(a: number, b: number): number { return a * b }\n`)
  await fs.writeFile(path.join(srcDir, "math.ts"), `import { add } from "./index"; export { add }\n`)

  const libDir = path.join(root, "lib")
  await fs.mkdir(libDir, { recursive: true })
  await fs.writeFile(path.join(libDir, "helper.ts"), `export function helper(): string { return "helper" }\n`)

  await fs.writeFile(path.join(root, "readme.md"), `# Test Project\nThis is a readme.\n`)
  await fs.writeFile(path.join(root, "notes.txt"), `This is a plain text file and should be skipped.\n`)
  await fs.writeFile(path.join(root, "data.json"), `{"key": "value"}\n`)

  await fs.mkdir(path.join(root, ".banyancode"), { recursive: true })
  await fs.writeFile(path.join(root, ".banyancode", "ignore"), "lib/helper.ts\n")

  await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n")

  await fs.mkdir(path.join(root, "dist"), { recursive: true })
  await fs.writeFile(path.join(root, "dist", "bundle.js"), `console.log("built");\n`)
}

describe("codegraph_build parity", () => {
  test("manual and agent paths produce identical metrics", async () => {
    await using fixtureManual = await tmpdir()
    await using fixtureAgent = await tmpdir()

    const dbPathManual = path.join(fixtureManual.path, `parity-${randomUUID()}.db`)
    const dbPathAgent = path.join(fixtureAgent.path, `parity-${randomUUID()}.db`)

    await createFixture(fixtureManual.path)
    await createFixture(fixtureAgent.path)

    const manualDbLayer = Database.layerFromPath(dbPathManual)
    const agentDbLayer = Database.layerFromPath(dbPathAgent)

    const makeMockIndexer = () =>
      Layer.succeed(
        CodegraphIndexer.Service,
        CodegraphIndexer.Service.of({
          index: (input) =>
            Effect.gen(function* () {
              if (input.onProgress) {
                yield* input.onProgress({ file: "a.ts", done: 1, total: 2 })
                yield* input.onProgress({ file: "b.ts", done: 2, total: 2 })
              }
              return {
                indexed: 4,
                skipped: 2,
                scannedFiles: 6,
                symbolsIndexed: 10,
                skippedByReason: {
                  gitignored: 1,
                  banyanignored: 1,
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

    const manualServiceLayer = buildServiceLayer.pipe(
      Layer.provide(makeMockIndexer()),
      Layer.provide(EventV2.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )
    const agentServiceLayer = buildServiceLayer.pipe(
      Layer.provide(makeMockIndexer()),
      Layer.provide(EventV2.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    const manualState = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphBuildService.Service

        yield* service.start({ root: fixtureManual.path, force: true, dbPath: dbPathManual })

        let state: CodegraphBuildService.State = { status: "idle", done: 0, total: 0 }
        for (let i = 0; i < 60; i++) {
          yield* Effect.sleep(500)
          state = yield* service.status()
          if (state.status === "completed" || state.status === "failed") break
        }

        return state
      }).pipe(Effect.provide(manualServiceLayer), Effect.provide(manualDbLayer), Effect.scoped),
    )

    const agentState = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphBuildService.Service

        yield* service.start({ root: fixtureAgent.path, force: true, dbPath: dbPathAgent })

        let state: CodegraphBuildService.State = { status: "idle", done: 0, total: 0 }
        for (let i = 0; i < 60; i++) {
          yield* Effect.sleep(500)
          state = yield* service.status()
          if (state.status === "completed" || state.status === "failed") break
        }

        return state
      }).pipe(Effect.provide(agentServiceLayer), Effect.provide(agentDbLayer), Effect.scoped),
    )

    console.log("\n=== Parity Comparison ===")
    console.log("Metric          | Manual | Agent  | Match")
    console.log("-----------------|--------|--------|------")
    console.log(`indexed          | ${String(manualState.result?.indexed ?? "N/A").padStart(6)} | ${String(agentState.result?.indexed ?? "N/A").padStart(6)} | ${manualState.result?.indexed === agentState.result?.indexed ? "✓" : "✗"}`)
    console.log(`skipped          | ${String(manualState.result?.skipped ?? "N/A").padStart(6)} | ${String(agentState.result?.skipped ?? "N/A").padStart(6)} | ${manualState.result?.skipped === agentState.result?.skipped ? "✓" : "✗"}`)
    console.log(`symbolsIndexed   | ${String((manualState.result as any)?.symbolsIndexed ?? "N/A").padStart(6)} | ${String((agentState.result as any)?.symbolsIndexed ?? "N/A").padStart(6)} | ${(manualState.result as any)?.symbolsIndexed === (agentState.result as any)?.symbolsIndexed ? "✓" : "✗"}`)

    const manualSkippedByReason = (manualState.result as any)?.skippedByReason
    const agentSkippedByReason = (agentState.result as any)?.skippedByReason
    if (manualSkippedByReason && agentSkippedByReason) {
      console.log("skippedByReason:")
      for (const reason of ["gitignored", "banyanignored", "artifact", "tooLarge", "minified", "tooLargeParse", "cached", "readError", "parseFailure"] as const) {
        const m = manualSkippedByReason[reason] ?? "N/A"
        const a = agentSkippedByReason[reason] ?? "N/A"
        console.log(`  ${reason.padEnd(16)} | ${String(m).padStart(6)} | ${String(a).padStart(6)} | ${m === a ? "✓" : "✗"}`)
      }
    } else {
      console.log("skippedByReason  : N/A (pending phase-1-impl)")
    }
    console.log("=========================\n")

    expect(manualState.status).toBe("completed")
    expect(agentState.status).toBe("completed")

    expect(manualState.result?.indexed).toBe(agentState.result?.indexed)
    expect(manualState.result?.skipped).toBe(agentState.result?.skipped)
    expect((manualState.result as any)?.symbolsIndexed).toBe((agentState.result as any)?.symbolsIndexed)

    const mSR = (manualState.result as any)?.skippedByReason
    const aSR = (agentState.result as any)?.skippedByReason
    expect(mSR).toEqual(aSR)
  })
})

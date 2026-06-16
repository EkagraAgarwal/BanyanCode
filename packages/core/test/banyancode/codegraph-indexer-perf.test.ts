import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo } from "../../src/banyancode/codegraph-repo"
import { FSUtil } from "../../src/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"

describe("CodegraphIndexer performance", () => {
  test("builds 50-file fixture in under 5 seconds", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "perf-test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    // Build 50-file fixture with 5 functions each
    const fixtureRoot = path.join(tmp.path, "fixture")
    await fs.mkdir(fixtureRoot, { recursive: true })
    for (let f = 0; f < 50; f++) {
      const filePath = path.join(fixtureRoot, `file${f}.ts`)
      const content = `// File ${f}\n` + Array.from({ length: 5 }, (_, i) =>
        `export function func${i}() { return ${i}; }\n`,
      ).join("")
      await fs.writeFile(filePath, content, "utf-8")
    }

    const indexerLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(CodegraphRepo.layer),
      Layer.provide(FSUtil.defaultLayer),
    )

    const start = performance.now()

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const result = yield* indexer.index({ root: fixtureRoot, force: true })
        expect(result.indexed).toBe(50)
      }).pipe(
        Effect.provide(indexerLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )

    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(5000)
  })
})

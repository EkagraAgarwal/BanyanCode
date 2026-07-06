import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"

process.env.BANYANCODE_ENABLE = "1"

describe("CodegraphRepo parse errors", () => {
  test("recordParseError and listParseErrors work", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const repoLayer = codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        yield* repo.recordParseError({ path: "src/broken.ts", cause: "Syntax error", indexedAt: Date.now() })
        yield* repo.recordParseError({ path: "src/also-broken.ts", cause: "Unknown token", indexedAt: Date.now() })

        const errors = yield* repo.listParseErrors()
        expect(errors.length).toBe(2)
        expect(errors[0].path).toBe("src/also-broken.ts")
        expect(errors[1].path).toBe("src/broken.ts")

        yield* repo.clearParseErrors()

        const errorsAfterClear = yield* repo.listParseErrors()
        expect(errorsAfterClear.length).toBe(0)
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )
  })

  test("indexer parseErrors array is always empty (regex parser does not throw)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const srcDir = path.join(tmp.path, "src")
    await fs.mkdir(srcDir, { recursive: true })

    await fs.writeFile(path.join(srcDir, "normal.ts"), `export function add(a: number, b: number): number { return a + b }`)

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({ root: tmp.path, force: true })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(result.parseErrors).toEqual([])
  })
})
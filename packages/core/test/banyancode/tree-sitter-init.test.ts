import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import {
  _resetTreeSitterStateForTesting,
  ensureWebTreeSitterReady,
  TreeSitter,
  TreeSitterUnavailableError,
  treeSitterStateRef,
} from "../../src/banyancode/langs/tree-sitter"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"

process.env.BANYANCODE_ENABLE = "1"

const setWasmEnv = (value: string | undefined): void => {
  if (value === undefined) {
    delete process.env.TREE_SITTER_WASM_PATH
  } else {
    process.env.TREE_SITTER_WASM_PATH = value
  }
}

describe("tree-sitter init hardening (Phase 2a)", () => {
  test("happy path: valid wasm resolves state to 'ready'", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    setWasmEnv(undefined)
    await Effect.runPromise(_resetTreeSitterStateForTesting())
    await Effect.runPromise(ensureWebTreeSitterReady())

    const state = await Effect.runPromise(Ref.get(treeSitterStateRef))
    expect(state._tag).toBe("ready")

    const svc = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* TreeSitter.Service
        return yield* s.getLanguage(".ts")
      }).pipe(Effect.provide(Layer.provide(TreeSitter.layer, Database.layerFromPath(dbPath)))),
    )
    expect(svc).not.toBeNull()
    expect(typeof svc).toBe("object")
  })

  test("unavailable path: invalid wasm path leaves state as 'unavailable' instead of throwing", async () => {
    setWasmEnv("/this/path/definitely/does/not/exist/tree-sitter.wasm")
    await Effect.runPromise(_resetTreeSitterStateForTesting())

    await Effect.runPromise(ensureWebTreeSitterReady())

    const state = await Effect.runPromise(Ref.get(treeSitterStateRef))
    expect(state._tag).toBe("unavailable")
    if (state._tag === "unavailable") {
      expect(state.cause.length).toBeGreaterThan(0)
    }
  })

  test("unavailable state: parse returns TreeSitterUnavailableError without layer build failure", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    setWasmEnv("/this/path/definitely/does/not/exist/tree-sitter.wasm")
    await Effect.runPromise(_resetTreeSitterStateForTesting())

    const testLayer = Layer.provide(TreeSitter.layer, Database.layerFromPath(dbPath))

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TreeSitter.Service
        return yield* svc.parse(".ts", "export function foo() { return 1 }").pipe(Effect.flip)
      }).pipe(Effect.provide(testLayer)),
    )

    expect(error).toBeInstanceOf(TreeSitterUnavailableError)
    expect((error as TreeSitterUnavailableError).initCause.length).toBeGreaterThan(0)
  })

  test("regression: CodegraphIndexer layer constructs even when tree-sitter is unavailable", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    setWasmEnv("/this/path/definitely/does/not/exist/tree-sitter.wasm")
    await Effect.runPromise(_resetTreeSitterStateForTesting())

    const indexerLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    const svc = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* CodegraphIndexer.Service
      }).pipe(Effect.provide(indexerLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(svc).toBeDefined()
    expect(typeof svc.index).toBe("function")
    expect(typeof svc.cancel).toBe("function")

    setWasmEnv(undefined)
  })
})


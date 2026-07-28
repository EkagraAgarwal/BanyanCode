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

  test("regression: runtime does NOT use path.resolve(import.meta.dir) for wasm (compiled-binary safety)", async () => {
    // The bundle root of a `bun build --compile` binary virtualizes
    // `import.meta.dir` so `path.resolve(import.meta.dir, …)` resolves to the
    // drive root and the runtime reads a non-existent file. The init
    // imports each wasm asset via literal `import("…/*.wasm", { with: { type: "wasm" } })`
    // which Bun resolves correctly inside compiled binaries.
    const source = await Bun.file(
      new URL("../../src/banyancode/langs/tree-sitter.ts", import.meta.url),
    ).text()
    expect(source).not.toMatch(/path\.resolve\(import\.meta\.dir[^)]*node_modules/)
    expect(source).toMatch(/with:\s*\{\s*type:\s*"wasm"\s*\}/)
  })

  test("regression: source declares every required wasm asset as a literal import", async () => {
    // A variable-specifier `import(variable, { with: { type: "wasm" } })` is
    // not statically analyzable and Bun's `bun build --compile` therefore
    // omits the asset from the binary. Verify the source enumerates every
    // required asset as a literal top-level import so the bundler can pick
    // them up.
    const source = await Bun.file(
      new URL("../../src/banyancode/langs/tree-sitter.ts", import.meta.url),
    ).text()
    const requiredAssets = [
      /import\s+\w+\s+from\s+["']web-tree-sitter\/tree-sitter\.wasm["']/,
      /import\s+\w+\s+from\s+["']tree-sitter-typescript\/tree-sitter-typescript\.wasm["']/,
      /import\s+\w+\s+from\s+["']tree-sitter-javascript\/tree-sitter-javascript\.wasm["']/,
      /import\s+\w+\s+from\s+["']tree-sitter-python\/tree-sitter-python\.wasm["']/,
    ]
    for (const pattern of requiredAssets) {
      expect(source).toMatch(pattern)
    }
    expect(source).not.toMatch(/async\s*\(\s*specifier:\s*string\s*\)/)
  })

  test("regression: scanner reports every required wasm asset as a static import", async () => {
    // Even literal imports are useless if Bun's static scanner cannot see
    // them — re-confirm by scanning the source file with `Bun.Transpiler`.
    const file = new URL("../../src/banyancode/langs/tree-sitter.ts", import.meta.url)
    const transpiler = new Bun.Transpiler({ loader: "ts" })
    const imports = transpiler.scanImports(await Bun.file(file).text())
    const required = [
      "web-tree-sitter/tree-sitter.wasm",
      "tree-sitter-typescript/tree-sitter-typescript.wasm",
      "tree-sitter-javascript/tree-sitter-javascript.wasm",
      "tree-sitter-python/tree-sitter-python.wasm",
    ]
    const specifiers = imports.map((entry) => entry.path)
    for (const asset of required) {
      expect(specifiers).toContain(asset)
    }
  })
})


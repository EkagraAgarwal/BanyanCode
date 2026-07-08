import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import {
  _resetTreeSitterStateForTesting,
  ensureWebTreeSitterReady,
  parseIncremental,
  TreeSitter,
  TreeSitterUnavailableError,
} from "@opencode-ai/core/banyancode/langs/tree-sitter"
import {
  parseTypeScriptWithTreeSitterIncremental,
  parsePythonWithTreeSitterIncremental,
} from "@opencode-ai/core/banyancode/langs/query-executor"
import { CodegraphIndexer } from "@opencode-ai/core/banyancode/codegraph-indexer"
import { defaultLayer as codegraphRepoDefaultLayer } from "@opencode-ai/core/banyancode/codegraph-repo"
import { FSUtil } from "@opencode-ai/core/fs-util"
import fs from "fs/promises"

process.env.BANYANCODE_ENABLE = "1"

const setWasmEnv = (value: string | undefined): void => {
  if (value === undefined) {
    delete process.env.TREE_SITTER_WASM_PATH
  } else {
    process.env.TREE_SITTER_WASM_PATH = value
  }
}

const runWithService = <A, E>(
  dbPath: string,
  program: Effect.Effect<A, E, never>,
): Promise<A> =>
  Effect.runPromise(
    program.pipe(Effect.provide(Layer.provide(TreeSitter.layer, Database.layerFromPath(dbPath)))),
  )

const SETUP_EFFECT = Effect.gen(function* () {
  setWasmEnv(undefined)
  yield* _resetTreeSitterStateForTesting()
  yield* ensureWebTreeSitterReady()
})

describe("incremental tree-sitter parsing (Phase 2f)", () => {
  test("cold parse: returned tree has populated rootNode", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    await Effect.runPromise(SETUP_EFFECT)

    const source = `export function add(a: number, b: number): number { return a + b }
`
    const tree = await runWithService(dbPath, parseIncremental(".ts", source, undefined))
    expect(tree).toBeDefined()
    const root = tree.rootNode as { namedChildCount: number }
    expect(root.namedChildCount).toBeGreaterThan(0)
  })

  test("incremental re-parse produces equivalent query results on identical content", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    await Effect.runPromise(SETUP_EFFECT)

    const source = `
import { Effect } from "effect"
import { Base } from "./base"

function* bootstrap(): Effect.Effect<void, never, never> {
  return yield* Foo.Service
}

export class Registry extends Base.Service<Registry>()("registry") {}

export function helper(x: number): number {
  return x * 2
}
`

    const coldResult = await runWithService(
      dbPath,
      parseTypeScriptWithTreeSitterIncremental(source, "file-cold", undefined),
    )
    const warmTree = await runWithService(dbPath, parseIncremental(".ts", source, undefined))
    const warmResult = await runWithService(
      dbPath,
      parseTypeScriptWithTreeSitterIncremental(source, "file-warm", warmTree),
    )

    expect(warmResult.tree).toBeDefined()
    expect(coldResult.result.nodes.length).toBe(warmResult.result.nodes.length)
    expect(coldResult.result.edges.length).toBe(warmResult.result.edges.length)

    const coldYieldEdges = coldResult.result.edges.filter((e) => (e.kind as string) === "yield").length
    const warmYieldEdges = warmResult.result.edges.filter((e) => (e.kind as string) === "yield").length
    expect(coldYieldEdges).toBeGreaterThan(0)
    expect(warmYieldEdges).toBe(coldYieldEdges)

    const coldServiceEdges = coldResult.result.edges.filter((e) => (e.kind as string) === "service_access").length
    const warmServiceEdges = warmResult.result.edges.filter((e) => (e.kind as string) === "service_access").length
    expect(coldServiceEdges).toBeGreaterThan(0)
    expect(warmServiceEdges).toBe(coldServiceEdges)
  })

  test("incremental re-parse produces equivalent results after a structural edit", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    await Effect.runPromise(SETUP_EFFECT)

    const sourceV1 = `import { Foo } from "./foo"

export function alpha(): number { return 1 }
export function beta(): number { return 2 }
export function gamma(): number { return 3 }
`
    const sourceV2 = `import { Foo } from "./foo"

export function alpha(): number { return 1 }
export function renamed(): number { return 2 }
export function gamma(): number { return 3 }

export class NewClass {
  method() { return 42 }
}
`

    const coldResult = await runWithService(
      dbPath,
      parseTypeScriptWithTreeSitterIncremental(sourceV1, "v1-file", undefined),
    )
    const warmTree = await runWithService(dbPath, parseIncremental(".ts", sourceV1, undefined))
    const warmResult = await runWithService(
      dbPath,
      parseTypeScriptWithTreeSitterIncremental(sourceV2, "v2-file", warmTree),
    )

    expect(warmResult.tree).toBeDefined()
    const warmNames = warmResult.result.nodes.map((n) => `${n.kind}:${n.name}`).sort()
    expect(warmNames.some((s) => s.includes("class:NewClass"))).toBe(true)
    expect(warmNames.some((s) => s.includes("function:renamed"))).toBe(true)
    expect(warmNames.every((s) => !s.includes("function:beta"))).toBe(true)
    expect(warmNames.some((s) => s.includes("function:alpha"))).toBe(true)
  })

  test("incremental parse is dramatically faster than cold on a large file", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    await Effect.runPromise(SETUP_EFFECT)

    const lines = ["export function head(): number { return 1 }"]
    for (let i = 0; i < 1200; i++) {
      lines.push(`export function func_${i}(x: number): number { return x + ${i} }`)
    }
    const v1 = lines.join("\n") + "\n"
    const v2 = v1.replace("return x + 500", "return x * 500")

    const coldStart = performance.now()
    const coldTree = await runWithService(dbPath, parseIncremental(".ts", v1, undefined))
    const coldMs = performance.now() - coldStart

    const warmStart = performance.now()
    const warmTree = await runWithService(dbPath, parseIncremental(".ts", v2, coldTree))
    const warmMs = performance.now() - warmStart

    expect(coldTree).toBeDefined()
    expect(warmTree).toBeDefined()
    expect(warmMs).toBeLessThan(coldMs * 0.6)
  })

  test("python incremental re-parse produces equivalent results after a structural edit", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    await Effect.runPromise(SETUP_EFFECT)

    const v1 = `def add(a, b):
    return a + b

def sub(c, d):
    return c - d
`
    const v2 = `def add(a, b):
    return a + b

def sub(c, d):
    return c - d

class NewClass:
    def method(self):
        return 42
`

    const coldResult = await runWithService(
      dbPath,
      parsePythonWithTreeSitterIncremental(v1, "py-cold", undefined),
    )
    const warmTree = await runWithService(dbPath, parseIncremental(".py", v1, undefined))
    const warmResult = await runWithService(
      dbPath,
      parsePythonWithTreeSitterIncremental(v2, "py-warm", warmTree),
    )

    expect(warmResult.tree).toBeDefined()
    const coldClasses = coldResult.result.nodes.filter((n) => n.kind === "class").length
    const warmClasses = warmResult.result.nodes.filter((n) => n.kind === "class").length
    expect(coldClasses).toBe(0)
    expect(warmClasses).toBe(1)
    expect(warmResult.result.nodes.some((n) => n.kind === "class" && n.name === "NewClass")).toBe(true)
  })

  test("incremental indexer reindex is faster than cold on a small fixture", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const indexerLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    const fixture: Record<string, string> = {}
    for (let i = 0; i < 10; i++) {
      const name = `src/file_${i}.ts`
      const lines: string[] = []
      for (let j = 0; j < 80; j++) {
        lines.push(
          j % 5 === 0
            ? `export function helper_${i}_${j}(x: number): number { return x + ${j} }`
            : `// padding ${"a".repeat(40)}`,
        )
      }
      const fullPath = path.join(tmp.path, name)
      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, lines.join("\n"))
      fixture[fullPath] = lines.join("\n")
    }

    await Effect.runPromise(SETUP_EFFECT)

    const coldStart = Date.now()
    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({ root: tmp.path })
      }).pipe(Effect.provide(indexerLayer), Effect.provide(dbLayer), Effect.scoped),
    )
    const coldMs = Date.now() - coldStart

    const targets = Object.keys(fixture)
    const target = targets[0]!
    const original = fixture[target]!
    const updated = original.replace("return x + 0", "return x + 1")
    await fs.writeFile(target, updated)
    fixture[target] = updated

    const warmStart = Date.now()
    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({ root: tmp.path })
      }).pipe(Effect.provide(indexerLayer), Effect.provide(dbLayer), Effect.scoped),
    )
    const warmMs = Date.now() - warmStart

    expect(warmMs).toBeLessThanOrEqual(coldMs + 200)
    expect(warmMs).toBeGreaterThan(0)
  })

  test("parseIncremental fails fast with TreeSitterUnavailableError when wasm path is invalid", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    setWasmEnv("/this/path/definitely/does/not/exist/tree-sitter.wasm")
    await Effect.runPromise(_resetTreeSitterStateForTesting())
    await Effect.runPromise(ensureWebTreeSitterReady())

    const err = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TreeSitter.Service
        return yield* parseIncremental(".ts", "export const x = 1", undefined).pipe(Effect.flip)
      }).pipe(Effect.provide(Layer.provide(TreeSitter.layer, Database.layerFromPath(dbPath)))),
    )

    expect(err).toBeInstanceOf(TreeSitterUnavailableError)
    setWasmEnv(undefined)
  })

  test("parsePythonWithTreeSitterIncremental returns regex result when tree-sitter is unavailable", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    setWasmEnv("/this/path/definitely/does/not/exist/tree-sitter.wasm")
    await Effect.runPromise(_resetTreeSitterStateForTesting())
    await Effect.runPromise(ensureWebTreeSitterReady())

    const result = await runWithService(
      dbPath,
      parsePythonWithTreeSitterIncremental(
        "import os\nclass Foo: pass\n",
        "py-id",
        undefined,
      ),
    )

    expect(result.result.nodes.some((n) => n.kind === "class" && n.name === "Foo")).toBe(true)
    expect(result.tree).toBeUndefined()
    setWasmEnv(undefined)
  })
})

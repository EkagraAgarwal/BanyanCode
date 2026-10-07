import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import { HEAP_INITIAL_PAGES, HEAP_MAX_PAGES, TreeSitter } from "../../src/banyancode/langs/tree-sitter"

process.env.BANYANCODE_ENABLE = "1"

describe("tree-sitter-loader", () => {
  test("heap constants are correct per AD-2", () => {
    expect(HEAP_INITIAL_PAGES).toBe(256)
    expect(HEAP_MAX_PAGES).toBe(4096)
  })

  test("getLanguage returns a non-null Language for .ts", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const testLayer = Layer.provide(TreeSitter.layer, Database.layerFromPath(dbPath))

    const lang = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TreeSitter.Service
        return yield* svc.getLanguage(".ts")
      }).pipe(Effect.provide(testLayer))
    )
    expect(lang).not.toBeNull()
    expect(typeof lang).toBe("object")
  })

  test("parse returns a tree with at least one named child for valid TS", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const testLayer = Layer.provide(TreeSitter.layer, Database.layerFromPath(dbPath))

    const source = "export function add(a: number, b: number): number { return a + b }"
    const tree = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TreeSitter.Service
        return yield* svc.parse(".ts", source)
      }).pipe(Effect.provide(testLayer))
    )

    expect(tree).toBeDefined()
    const rootNode = tree.rootNode as { childCount: number; namedChildCount: number }
    expect(rootNode.namedChildCount).toBeGreaterThan(0)
  })

  test("parse does NOT throw for malformed TS (tree-sitter is error-tolerant)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const testLayer = Layer.provide(TreeSitter.layer, Database.layerFromPath(dbPath))

    const brokenSource = "export function { broken"
    const tree = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TreeSitter.Service
        return yield* svc.parse(".ts", brokenSource)
      }).pipe(Effect.provide(testLayer))
    )

    expect(tree).toBeDefined()
    const rootNode = tree.rootNode as { childCount: number }
    expect(rootNode.childCount).toBeGreaterThanOrEqual(0)
  })

  test("parse returns a tree for Python source", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const testLayer = Layer.provide(TreeSitter.layer, Database.layerFromPath(dbPath))

    const pySource = "def add(a, b):\n    return a + b"
    const tree = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TreeSitter.Service
        return yield* svc.parse(".py", pySource)
      }).pipe(Effect.provide(testLayer))
    )

    expect(tree).toBeDefined()
    const rootNode = tree.rootNode as { namedChildCount: number }
    expect(rootNode.namedChildCount).toBeGreaterThan(0)
  })

  test("parse returns a tree for JS source", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const testLayer = Layer.provide(TreeSitter.layer, Database.layerFromPath(dbPath))

    const jsSource = "export function add(a, b) { return a + b }"
    const tree = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TreeSitter.Service
        return yield* svc.parse(".js", jsSource)
      }).pipe(Effect.provide(testLayer))
    )

    expect(tree).toBeDefined()
    const rootNode = tree.rootNode as { namedChildCount: number }
    expect(rootNode.namedChildCount).toBeGreaterThan(0)
  })
})

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import { parseTypeScript } from "@opencode-ai/core/banyancode/langs/typescript"
import { parsePython } from "@opencode-ai/core/banyancode/langs/python"
import {
  _resetTreeSitterStateForTesting,
  ensureWebTreeSitterReady,
  TreeSitter,
  TreeSitterUnavailableError,
} from "@opencode-ai/core/banyancode/langs/tree-sitter"
import {
  parseTypeScriptWithTreeSitter,
  parsePythonWithTreeSitter,
  validateQueryFile,
} from "@opencode-ai/core/banyancode/langs/query-executor"

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

describe("tree-sitter query files (Phase 2b)", () => {
  test("typescript.scm parses cleanly against tree-sitter-typescript", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    setWasmEnv(undefined)
    await Effect.runPromise(_resetTreeSitterStateForTesting())
    await Effect.runPromise(ensureWebTreeSitterReady())

    const ok = await runWithService(dbPath, validateQueryFile(".ts"))
    expect(ok).toBe(true)
  })

  test("javascript.scm parses cleanly against tree-sitter-javascript", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    setWasmEnv(undefined)
    await Effect.runPromise(_resetTreeSitterStateForTesting())
    await Effect.runPromise(ensureWebTreeSitterReady())

    const ok = await runWithService(dbPath, validateQueryFile(".js"))
    expect(ok).toBe(true)
  })

  test("python.scm parses cleanly against tree-sitter-python", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    setWasmEnv(undefined)
    await Effect.runPromise(_resetTreeSitterStateForTesting())
    await Effect.runPromise(ensureWebTreeSitterReady())

    const ok = await runWithService(dbPath, validateQueryFile(".py"))
    expect(ok).toBe(true)
  })

  test("yield* in a TS file produces a 'yield' edge keyed to the service identifier", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    setWasmEnv(undefined)
    await Effect.runPromise(_resetTreeSitterStateForTesting())
    await Effect.runPromise(ensureWebTreeSitterReady())

    const src = `
import { Effect } from "effect"
function* bootstrap(): Effect.Effect<void, never, never> {
  return yield* Foo.Service
  return yield* Bar.Service
}
`
    const result = await runWithService(
      dbPath,
      parseTypeScriptWithTreeSitter(src, "test-file-id"),
    )

    const yieldEdges = result.edges.filter((e) => (e.kind as string) === "yield")
    expect(yieldEdges.length).toBe(2)
    const targets = yieldEdges.map((e) => e.toNodeID).sort()
    expect(targets).toEqual(["service:Bar.Service", "service:Foo.Service"])
    for (const edge of yieldEdges) {
      expect(edge.id).toMatch(/^test-file-id:yield:/)
      expect(edge.fromNodeID).toMatch(/^test-file-id:function:/)
    }
  })

  test("Context.Service<...>()('tag') registration produces a 'service_access' edge with the tag as toNodeID", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    setWasmEnv(undefined)
    await Effect.runPromise(_resetTreeSitterStateForTesting())
    await Effect.runPromise(ensureWebTreeSitterReady())

    const src = `
import { Context } from "effect"
class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphBuildService") {}
`
    const result = await runWithService(
      dbPath,
      parseTypeScriptWithTreeSitter(src, "test-file-id"),
    )

    const serviceEdges = result.edges.filter((e) => (e.kind as string) === "service_access")
    expect(serviceEdges.length).toBeGreaterThan(0)
    const edge = serviceEdges[0]!
    expect(edge.toNodeID).toBe("service:@banyancode/CodegraphBuildService")
    expect(edge.fromNodeID).toBe("test-file-id:class:Service:3")
  })

  test("obj.method() produces a 'calls' edge keyed to the property name", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    setWasmEnv(undefined)
    await Effect.runPromise(_resetTreeSitterStateForTesting())
    await Effect.runPromise(ensureWebTreeSitterReady())

    const src = `
function go() {
  return obj.method()
}
`
    const result = await runWithService(
      dbPath,
      parseTypeScriptWithTreeSitter(src, "test-file-id"),
    )

    const callsEdges = result.edges.filter((e) => e.kind === "calls")
    expect(callsEdges.some((e) => e.toNodeID === "symbol:method")).toBe(true)
  })

  test("Python yield + class registration both extract through parsePythonWithTreeSitter", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    setWasmEnv(undefined)
    await Effect.runPromise(_resetTreeSitterStateForTesting())
    await Effect.runPromise(ensureWebTreeSitterReady())

    const pySrc = `
class Service(MyContext.Service("svc-tag")):
    pass

def gen():
    yield Foo.Service
`
    const result = await runWithService(
      dbPath,
      parsePythonWithTreeSitter(pySrc, "py-file-id"),
    )

    const yieldEdges = result.edges.filter((e) => (e.kind as string) === "yield")
    expect(yieldEdges.length).toBeGreaterThan(0)
    expect(yieldEdges.some((e) => e.toNodeID === "service:Foo.Service")).toBe(true)

    const serviceEdges = result.edges.filter((e) => (e.kind as string) === "service_access")
    expect(serviceEdges.some((e) => e.toNodeID === "service:svc-tag")).toBe(true)
  })

  test("regex parser still works when tree-sitter is unavailable (graceful degradation)", () => {
    const src = `
import { Foo } from "./foo"
export class Service {}
export function helper() { return 1 }
`
    const result = parseTypeScript(src, "reg-file-id")
    const imports = result.edges.filter((e) => e.kind === "imports")
    expect(imports.length).toBeGreaterThan(0)
    expect(result.nodes.some((n) => n.kind === "class" && n.name === "Service")).toBe(true)
    expect(result.nodes.some((n) => n.kind === "function" && n.name === "helper")).toBe(true)
  })

  test("parseTypeScriptWithTreeSitter fails with TreeSitterUnavailableError when wasm path is invalid", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    setWasmEnv("/this/path/definitely/does/not/exist/tree-sitter.wasm")
    await Effect.runPromise(_resetTreeSitterStateForTesting())
    await Effect.runPromise(ensureWebTreeSitterReady())

    const err = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TreeSitter.Service
        return yield* parseTypeScriptWithTreeSitter("export const x = 1", "id").pipe(Effect.flip)
      }).pipe(Effect.provide(Layer.provide(TreeSitter.layer, Database.layerFromPath(dbPath)))),
    )
    expect(err).toBeInstanceOf(TreeSitterUnavailableError)
    setWasmEnv(undefined)
  })

  test("regex parser does not throw on malformed TS (independent of tree-sitter)", () => {
    const broken = "export function { broken"
    expect(() => parseTypeScript(broken, "broken-id")).not.toThrow()
    const result = parsePython("def :\n  pass # missing name", "py-broken-id")
    expect(result).toBeDefined()
  })
})
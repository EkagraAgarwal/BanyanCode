import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import type { CodeFindGraph } from "../../src/intel/code-find.js"
import { buildTools } from "../../src/intel/tools.js"
import type { GraphEdge, GraphFile, GraphMeta, GraphNode } from "../../src/intel/types.js"
import { make as makeRepositoryIntelligence } from "../../src/intel/service.js"
import { makeFixture } from "./fixture.js"

/**
 * The three `repo` ops added by the consolidation: `outline` (one file's
 * symbols + caller/import summary), `files` (glob over indexed paths) and
 * `structural` (recursive / async / http_routes).
 *
 * The port fixture contains real row shapes; the structural service is the
 * only stub because those functions need the tree-sitter indexer, not the
 * port.
 */

const meta: GraphMeta = {
  graphBuiltAt: 1,
  graphVersion: 1,
  graphCoverage: 1,
  totalFiles: 3,
  totalNodes: 5,
  totalEdges: 3,
}

const files: GraphFile[] = [
  { id: "f1", path: "src/a.ts", contentHash: "h1", language: "typescript", indexedAt: 1 },
  { id: "f2", path: "src/b.ts", contentHash: "h2", language: "typescript", indexedAt: 1 },
  { id: "f3", path: "test/a.test.ts", contentHash: "h3", language: "typescript", indexedAt: 1 },
]

const nodes: GraphNode[] = [
  { id: "n1", fileID: "f1", kind: "function", name: "Helper", startLine: 1, endLine: 3 },
  { id: "n2", fileID: "f1", kind: "class", name: "Widget", startLine: 5, endLine: 10 },
  { id: "n3", fileID: "f2", kind: "function", name: "useHelper", startLine: 12, endLine: 15 },
  { id: "n4", fileID: "f3", kind: "test", name: "helper test", startLine: 1, endLine: 6 },
  { id: "n5", fileID: "f2", kind: "route", name: "GET /helper", startLine: 20, endLine: 22 },
]

const edges: GraphEdge[] = [
  { id: "e1", fromNodeID: "n3", toNodeID: "n1", kind: "calls" },
  { id: "e2", fromNodeID: "n4", toNodeID: "n1", kind: "tested_by" },
  { id: "e3", fromNodeID: "n1", toNodeID: "n3", kind: "imports" },
]

const fixture = makeFixture({ files, nodes, edges, meta })

const structural = {
  findImplementations: () => Effect.succeed([]),
  findOverrides: () => Effect.succeed([]),
  findRecursiveFunctions: () => Effect.succeed([nodes[0]!]),
  findAsyncFunctions: () => Effect.succeed([nodes[2]!]),
  findHTTPRoutes: () => Effect.succeed([nodes[4]!]),
}

const graph = {
  search: { search: () => Effect.succeed([]) },
  structural,
} as unknown as CodeFindGraph

const ctx = { permission: { assert: () => Effect.void } } as unknown as Context
const intel = makeRepositoryIntelligence(fixture.port, { cwd: process.cwd() })
const tools = buildTools({ ctx, port: fixture.port, intel, graph })
const repo = tools.find((tool) => tool.name === "repo")!

const run = (input: Record<string, unknown>) => repo.execute(input, {} as never)

describe("repo op=outline", () => {
  test("returns every symbol of one file with the augment header", async () => {
    const result = await Effect.runPromise(run({ op: "outline", path: "src/a.ts" }))
    const output = result.output as {
      op: string
      outline: {
        path: string
        header: string
        imports: number
        callers: number
        symbols: Array<{ kind: string; name: string; startLine: number; endLine: number }>
      }
    }
    expect(output.op).toBe("outline")
    expect(output.outline.path).toBe("src/a.ts")
    expect(output.outline.symbols.map((symbol) => symbol.name)).toEqual(["Helper", "Widget"])
    expect(output.outline.symbols.map((symbol) => symbol.kind)).toEqual(["function", "class"])
    expect(output.outline.symbols[0]).toMatchObject({ startLine: 1, endLine: 3 })
    expect(output.outline.callers).toBe(1)
    expect(output.outline.imports).toBe(1)
    expect(output.outline.header).toContain("Symbol: Widget")
    expect(output.outline.header).toContain("Callers: 1")
    expect(result.content).toContain("function Helper (1-3)")
  })

  test("reports an error for a path that is not indexed", async () => {
    const exit = await Effect.runPromiseExit(run({ op: "outline", path: "src/nope.ts" }))
    expect(exit._tag).toBe("Failure")
  })
})

describe("repo op=files", () => {
  test("globs indexed paths and sorts them", async () => {
    const result = await Effect.runPromise(run({ op: "files", pattern: "src/**/*.ts" }))
    const output = result.output as { files: Array<{ path: string }>; total: number; truncated: boolean }
    expect(output.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"])
    expect(output.total).toBe(2)
    expect(output.truncated).toBe(false)
  })

  test("matches basenames for a slash-free pattern and honours limit", async () => {
    const all = await Effect.runPromise(run({ op: "files", pattern: "*.test.ts" }))
    expect((all.output as { files: Array<{ path: string }> }).files.map((file) => file.path)).toEqual(["test/a.test.ts"])

    const limited = await Effect.runPromise(run({ op: "files", pattern: "**/*.ts", limit: 1 }))
    const output = limited.output as { files: Array<{ path: string }>; truncated: boolean }
    expect(output.files).toHaveLength(1)
    expect(output.truncated).toBe(true)
  })
})

describe("repo op=structural", () => {
  test("kind selects recursive, async and http_routes queries", async () => {
    const recursive = await Effect.runPromise(run({ op: "structural", kind: "recursive" }))
    expect((recursive.output as { nodes: Array<{ name: string }> }).nodes.map((node) => node.name)).toEqual(["Helper"])

    const asyncRun = await Effect.runPromise(run({ op: "structural", kind: "async" }))
    expect((asyncRun.output as { nodes: Array<{ name: string }> }).nodes.map((node) => node.name)).toEqual(["useHelper"])

    const routes = await Effect.runPromise(run({ op: "structural", kind: "http_routes" }))
    expect((routes.output as { nodes: Array<{ name: string }> }).nodes.map((node) => node.name)).toEqual(["GET /helper"])
  })
})

describe("code_find intent=impact", () => {
  const codeFind = tools.find((tool) => tool.name === "code_find")!
  const matches = async (target: string) => {
    const result = await Effect.runPromise(codeFind.execute({ intent: "impact", target }, {} as never))
    return (result.output as { matches: Array<{ node: { id: string } }>; dispatchedTo: string })
  }

  test("is kept for the MCP banyan_code_find tool and walks a symbol's dependents", async () => {
    const output = await matches("Helper")
    expect(output.dispatchedTo).toBe("impact")
    expect(output.matches.map((match) => match.node.id)).toContain("n3")
  })

  test("aggregates over a file when the target is a path", async () => {
    const output = await matches("src/a.ts")
    expect(output.matches.map((match) => match.node.id)).toContain("n3")
  })
})

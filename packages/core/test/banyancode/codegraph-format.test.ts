import { describe, expect, test } from "bun:test"

process.env.BANYANCODE_ENABLE = "1"

import { formatNodes, formatCodegraphSearchResults } from "../../src/tool/codegraph-format"
import type { CodegraphFile, CodegraphNode } from "../../src/banyancode/types"

const node = (
  id: string,
  fileID: string,
  name: string,
  kind: CodegraphNode["kind"] = "function",
  startLine = 1,
  endLine = 10,
): CodegraphNode => ({
  id,
  fileID,
  kind,
  name,
  startLine,
  endLine,
})

const file = (id: string, path: string): CodegraphFile => ({
  id,
  path,
  contentHash: `hash-${id}`,
  language: "ts",
  indexedAt: 0,
})

describe("formatNodes with filesByID", () => {
  test("renders file path when fileID resolves in filesByID", () => {
    const nodes = [node("n1", "f1", "MemoryRepo")]
    const filesByID = new Map([["f1", file("f1", "packages/core/src/banyancode/memory-repo.ts")]])
    const out = formatNodes(nodes, "Matches", filesByID)
    expect(out).toContain("packages/core/src/banyancode/memory-repo.ts:1-10")
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
  })

  test("falls back to UUID when fileID is not in filesByID", () => {
    const nodes = [node("n1", "fMissing", "MemoryRepo")]
    const filesByID = new Map<string, CodegraphFile>()
    const out = formatNodes(nodes, "Matches", filesByID)
    expect(out).toContain("fMissing:1-10")
    expect(out).not.toContain("packages/")
  })

  test("falls back to UUID when filesByID is undefined", () => {
    const nodes = [node("n1", "f1", "MemoryRepo")]
    const out = formatNodes(nodes, "Matches")
    expect(out).toContain("f1:1-10")
  })

  test("renders multiple nodes with mixed resolution", () => {
    const nodes = [
      node("n1", "f1", "MemoryRepo"),
      node("n2", "fMissing", "CodegraphAnalyzer"),
      node("n3", "f3", "SymbolResolver"),
    ]
    const filesByID = new Map([
      ["f1", file("f1", "packages/core/src/memory-repo.ts")],
      ["f3", file("f3", "packages/core/src/symbol-resolver.ts")],
    ])
    const out = formatNodes(nodes, "Matches", filesByID)
    expect(out).toContain("packages/core/src/memory-repo.ts:1-10")
    expect(out).toContain("packages/core/src/symbol-resolver.ts:1-10")
    expect(out).toContain("fMissing:1-10")
  })

  test("preserves signature truncation", () => {
    const nodes: CodegraphNode[] = [
      {
        ...node("n1", "f1", "foo"),
        signature: "(a: string, b: number, c: boolean, d: object, e: function-with-long-name) => Promise<void>",
      },
    ]
    const filesByID = new Map([["f1", file("f1", "src/foo.ts")]])
    const out = formatNodes(nodes, "Matches", filesByID)
    expect(out).toContain("src/foo.ts:1-10")
    expect(out).toContain("\u2026")
  })

  test("empty nodes → 'Matches: none.' regardless of filesByID", () => {
    const filesByID = new Map([["f1", file("f1", "src/foo.ts")]])
    expect(formatNodes([], "Matches", filesByID)).toBe("Matches: none.")
  })

  test("truncates result with '... and N more' when over MAX_NODES_PER_OUTPUT", () => {
    const nodes: CodegraphNode[] = []
    const filesByID = new Map<string, CodegraphFile>()
    for (let i = 0; i < 30; i++) {
      const id = `n${i}`
      const fileID = `f${i}`
      nodes.push(node(id, fileID, `sym${i}`))
      filesByID.set(fileID, file(fileID, `src/sym${i}.ts`))
    }
    const out = formatNodes(nodes, "Matches", filesByID)
    expect(out).toContain("(30):")
    expect(out).toContain("... and 5 more")
  })
})

describe("formatCodegraphSearchResults with filesByID", () => {
  test("renders file path in search results when fileID resolves", () => {
    const results = [{ node: node("n1", "f1", "MemoryRepo"), score: 0.95 }]
    const filesByID = new Map([["f1", file("f1", "packages/core/src/memory-repo.ts")]])
    const out = formatCodegraphSearchResults(results, filesByID)
    expect(out).toContain("packages/core/src/memory-repo.ts:1-10")
    expect(out).toContain("[score=0.95]")
  })

  test("falls back to UUID when fileID missing", () => {
    const results = [{ node: node("n1", "fMissing", "MemoryRepo"), score: 0.5 }]
    const out = formatCodegraphSearchResults(results)
    expect(out).toContain("fMissing:1-10")
  })
})
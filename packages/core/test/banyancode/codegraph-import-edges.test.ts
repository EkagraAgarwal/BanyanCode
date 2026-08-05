import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import type { CodegraphEdge } from "../../src/banyancode/types"

process.env.BANYANCODE_ENABLE = "1"

const serviceLayer = CodegraphIndexer.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(codegraphRepoDefaultLayer),
)

const repoLayer = codegraphRepoDefaultLayer

// Phase 5 (P8a): `imports` was declared in the derived-edge union but never
// emitted — the import-scope scan only built an in-scope node set. These
// tests lock the new behavior: one `imports` edge per imported FILE, from the
// importing file's file-kind node to the imported file's file-kind node.
describe("codegraph imports edges (Phase 5)", () => {
  test("emits one imports edge from the importing file node to the imported file node", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const srcDir = path.join(tmp.path, "src")
    await fs.mkdir(srcDir, { recursive: true })
    // a.ts imports ./b twice (named + side-effect) — both must collapse into
    // ONE file-level imports edge via the referenceEdgeKeys dedup.
    await fs.writeFile(
      path.join(srcDir, "a.ts"),
      `import { x } from "./b"\nimport "./b"\nexport function useX() { return x() }\n`,
    )
    await fs.writeFile(path.join(srcDir, "b.ts"), `export function x() { return 42 }\n`)

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        yield* indexer.index({ root: tmp.path, force: true })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const aFile = yield* repo.getFileByPath(path.join(srcDir, "a.ts"))
        const bFile = yield* repo.getFileByPath(path.join(srcDir, "b.ts"))
        if (!aFile || !bFile) return undefined
        const edges = yield* repo.listAllEdges()
        const nodes = yield* repo.listAllNodes()
        return { aFile, bFile, edges, nodeIDs: nodes.map((n) => n.id) }
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(result).toBeDefined()
    if (!result) return
    const { aFile, bFile, edges, nodeIDs } = result

    const fromNodeID = `${aFile.id}:file`
    const toNodeID = `${bFile.id}:file`
    const importEdges = edges.filter(
      (e) => e.kind === "imports" && e.fromNodeID === fromNodeID && e.toNodeID === toNodeID,
    )

    expect(importEdges).toHaveLength(1)
    expect(importEdges[0]).toMatchObject({ fromNodeID, toNodeID, kind: "imports" })

    // Both endpoints must resolve to real nodes in the graph (no orphans).
    expect(nodeIDs).toContain(fromNodeID)
    expect(nodeIDs).toContain(toNodeID)
  })

  test("an import edge endpoint is the imported file node, not a module: pseudo-node", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const srcDir = path.join(tmp.path, "src")
    await fs.mkdir(srcDir, { recursive: true })
    await fs.writeFile(path.join(srcDir, "main.ts"), `import { helper } from "./helper"\nexport function run() { return helper() }\n`)
    await fs.writeFile(path.join(srcDir, "helper.ts"), `export function helper() { return 1 }\n`)

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        yield* indexer.index({ root: tmp.path, force: true })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    const edges = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        return yield* repo.listAllEdges()
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    const importEdges = edges.filter((e) => e.kind === "imports")
    expect(importEdges.length).toBeGreaterThan(0)
    // Regex-parser imports edge form (`module:<specifier>`) must not leak
    // into the DB as an `imports` edge — the derived pass replaces it with a
    // file-node endpoint.
    for (const e of importEdges) {
      expect(e.toNodeID.startsWith("module:")).toBe(false)
      expect(e.fromNodeID.endsWith(":file")).toBe(true)
      expect(e.toNodeID.endsWith(":file")).toBe(true)
    }
  })
})

// Phase 5 (P8b): reference classification previously ran `includes()`
// substring checks on raw node code, so a comment mentioning a symbol or a
// string literal containing `name(` fabricated bogus `references`/`calls`
// edges. These tests lock the strip-comments-and-strings behavior.
describe("codegraph reference classification excludes comments and strings (Phase 5)", () => {
  test("no references/calls edge fires for symbols that appear only in comments or strings", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const srcDir = path.join(tmp.path, "src")
    await fs.mkdir(srcDir, { recursive: true })
    await fs.writeFile(
      path.join(srcDir, "defs.ts"),
      [
        "export class UsedSymbol {}",
        "export class CommentedSymbol {}",
        "export class StringedSymbol {}",
        "export function someCall() { return 1 }",
        "export function stringedCall() { return 2 }",
        "",
      ].join("\n"),
    )
    await fs.writeFile(
      path.join(srcDir, "consumer.ts"),
      [
        "export function realUse() {",
        "  // CommentedSymbol is mentioned only in this comment.",
        '  const note = "StringedSymbol( and stringedCall( appear only inside strings"',
        "  const s = new UsedSymbol()",
        "  someCall()",
        "  return s",
        "}",
        "",
      ].join("\n"),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        yield* indexer.index({ root: tmp.path, force: true })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const consumerFile = yield* repo.getFileByPath(path.join(srcDir, "consumer.ts"))
        const defsFile = yield* repo.getFileByPath(path.join(srcDir, "defs.ts"))
        if (!consumerFile || !defsFile) return undefined
        const consumerNodes = yield* repo.listNodesByFile(consumerFile.id)
        const defsNodes = yield* repo.listNodesByFile(defsFile.id)
        const edges = yield* repo.listAllEdges()
        return { consumerNodes, defsNodes, edges }
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(result).toBeDefined()
    if (!result) return
    const { consumerNodes, defsNodes, edges } = result

    const realUse = consumerNodes.find((n) => n.kind === "function" && n.name === "realUse")
    expect(realUse).toBeDefined()
    if (!realUse) return

    const nodeByID = new Map(defsNodes.map((n) => [n.id, n]))
    const edgesFromRealUse = edges.filter((e) => e.fromNodeID === realUse.id)
    const edgeTo = (targetName: string, kind?: string): CodegraphEdge[] => {
      const target = defsNodes.find((n) => n.name === targetName)
      if (!target) return []
      return edgesFromRealUse.filter(
        (e) => e.toNodeID === target.id && (kind === undefined || e.kind === kind),
      )
    }

    // Real uses still produce edges: `new UsedSymbol()` and `someCall()` both
    // survive the strip (kind is a heuristic — calls vs references — so assert
    // presence, not the exact kind).
    expect(edgeTo("UsedSymbol").length).toBeGreaterThan(0)
    expect(edgeTo("someCall").length).toBeGreaterThan(0)

    // Symbols that appear ONLY in a comment or a string literal must have no edge.
    expect(edgeTo("CommentedSymbol")).toHaveLength(0)
    expect(edgeTo("StringedSymbol")).toHaveLength(0)
    expect(edgeTo("stringedCall")).toHaveLength(0)

    // Sanity: the defs symbols are real nodes (so the assertions above are
    // not vacuous — they were in scope and would have matched pre-strip).
    expect(nodeByID.size).toBeGreaterThanOrEqual(5)
  })
})

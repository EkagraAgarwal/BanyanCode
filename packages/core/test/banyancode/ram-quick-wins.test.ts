import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "node:path"
import fs from "node:fs"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Banyan } from "@opencode-ai/core/banyancode"
import { CodegraphIndexer } from "@opencode-ai/core/banyancode/codegraph-indexer"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { FSUtil } from "@opencode-ai/core/fs-util"
import {
  MAX_HOT_GRAMMAR_FAMILIES,
  Service as TreeSitterService,
  _resetTreeSitterStateForTesting,
  ensureGrammarForExt,
  ensureWebTreeSitterReady,
  layer as treeSitterLayer,
  withTreeSitter,
} from "@opencode-ai/core/banyancode/langs/tree-sitter"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

describe("RAM quick wins", () => {
  test("artifact nodes cap code at 4000 chars", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "artifact")
    fs.mkdirSync(root, { recursive: true })
    const lines = ['{', '  "name": "big-pkg",', '  "version": "1.0.0",', '  "dependencies": {']
    for (let i = 0; i < 300; i++) lines.push(`    "dep-${i}": "1.0.${i}-patch-release-candidate",`)
    lines.push("  }", "}")
    const content = lines.join("\n")
    expect(content.length).toBeGreaterThan(4000)
    expect(lines.every((line) => line.length < 5000)).toBe(true)
    fs.writeFileSync(path.join(root, "package.json"), content)

    const dbPath = path.join(tmp.path, "artifact.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer.pipe(Layer.provide(dbLayer))
    const indexLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(dbLayer),
      Layer.provideMerge(repoLayer),
      Layer.provideMerge(FSUtil.defaultLayer),
    )

    const artifact = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const indexer = yield* CodegraphIndexer.Service
          const result = yield* indexer.index({ root, force: true })
          expect(result.indexed).toBe(1)
          const repo = yield* CodegraphRepo.Service
          const nodes = yield* repo.listAllNodes()
          return nodes.find((n) => n.id.includes(":artifact:"))
        }).pipe(Effect.provide(indexLayer)),
      ),
    )

    expect(artifact).toBeDefined()
    expect(artifact!.code!.length).toBeLessThanOrEqual(4000)
    expect(artifact!.code).toBe(content.slice(0, 4000))
  }, 120_000)

  test("batched persist transaction indexes every file", async () => {
    const prev = process.env.BANYANCODE_INDEX_PERSIST_BATCH
    process.env.BANYANCODE_INDEX_PERSIST_BATCH = "5"
    try {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "batched")
      fs.mkdirSync(root, { recursive: true })
      for (let i = 0; i < 12; i++) {
        fs.writeFileSync(path.join(root, `mod${i}.ts`), `export function batchedFn${i}(id: number): string {\n  return \`mod-${i}-\${id}\`\n}\n`)
      }

      const dbPath = path.join(tmp.path, "batched.db")
      const dbLayer = Database.layerFromPath(dbPath)
      const repoLayer = CodegraphRepo.layer.pipe(Layer.provide(dbLayer))
      const indexLayer = CodegraphIndexer.layer.pipe(
        Layer.provide(dbLayer),
        Layer.provideMerge(repoLayer),
        Layer.provideMerge(FSUtil.defaultLayer),
      )

      const checked = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const indexer = yield* CodegraphIndexer.Service
            const result = yield* indexer.index({ root, force: true })
            expect(result.indexed).toBe(12)
            const repo = yield* CodegraphRepo.Service
            expect(yield* repo.countNodes()).toBeGreaterThan(12)
            const hits = yield* repo.searchNodes({ name: "batchedFn7" })
            return hits.length
          }).pipe(Effect.provide(indexLayer)),
        ),
      )
      expect(checked).toBe(1)
    } finally {
      if (prev === undefined) delete process.env.BANYANCODE_INDEX_PERSIST_BATCH
      else process.env.BANYANCODE_INDEX_PERSIST_BATCH = prev
    }
  }, 120_000)

  test("vacuum deletes expired rows without returning and reports the count", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "vacuum.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const repo = yield* Banyan.MemoryRepo
        for (let i = 0; i < 3; i++) {
          yield* repo.put({
            id: `expired-${i}`,
            key: `expired-key-${i}`,
            value: { old: true },
            scope: "global",
            expiresAt: Date.now() - 5000,
          })
        }
        for (let i = 0; i < 2; i++) {
          yield* repo.put({ id: `valid-${i}`, key: `valid-key-${i}`, value: { fresh: true }, scope: "global" })
        }

        expect(yield* repo.vacuum()).toBe(3)
        expect(yield* repo.get("valid-0")).toBeDefined()
        expect(yield* repo.get("expired-0")).toBeUndefined()
        expect((yield* repo.list("global")).length).toBe(2)
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("list and search project rows without the JSONB value column", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "projection.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const repo = yield* Banyan.MemoryRepo
        yield* repo.put({
          id: "proj-1",
          key: "decision:turso",
          value: {
            kind: "decision",
            title: "Use Turso",
            body: "Storage backend is Turso/libSQL. " + "padding ".repeat(2000),
            source: { type: "user" },
            confidence: "high",
            importance: "high",
            status: "active",
          },
          scope: "global",
        })

        const listed = yield* repo.list("global")
        expect(listed.length).toBe(1)
        expect(listed[0]).toMatchObject({ key: "decision:turso", kind: "decision", title: "Use Turso", status: "active" })
        expect(listed[0]!.body).toContain("Storage backend is Turso")
        expect((listed[0]!.value as { _v: number })._v).toBe(1)

        const found = yield* repo.search("global", undefined, "decision:turso")
        expect(found.length).toBe(1)
        expect(found[0]).toMatchObject({ key: "decision:turso", title: "Use Turso" })
        expect((found[0]!.value as { _v: number })._v).toBe(1)
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("parse snapshots toString eagerly past tree teardown", async () => {
    const tree = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TreeSitterService
        return yield* svc.parse(".ts", "export const snapshotMe = 1\n")
      }).pipe(Effect.provide(treeSitterLayer)),
    )
    expect(tree.rootNode).not.toBeNull()
    expect(tree.rootNode!.childCount).toBeGreaterThan(0)
    expect(typeof tree.rootNode!.toString()).toBe("string")
    expect(tree.rootNode!.toString().length).toBeGreaterThan(0)
  }, 120_000)

  test("grammar cache evicts cold families past the hot cap", async () => {
    await Effect.runPromise(_resetTreeSitterStateForTesting())
    await Effect.runPromise(ensureWebTreeSitterReady())
    for (const ext of [".ts", ".py", ".rs", ".go", ".c"] as const) {
      await Effect.runPromise(ensureGrammarForExt(ext))
    }

    const afterLoad = await Effect.runPromise(
      withTreeSitter((state) => ({
        hasTs: state.parser.languagesByExt.has(".ts"),
        hasC: state.parser.languagesByExt.has(".c"),
        families: state.parser.grammarUseOrder.length,
      })),
    )
    expect(afterLoad.families).toBeLessThanOrEqual(MAX_HOT_GRAMMAR_FAMILIES)
    expect(afterLoad.hasTs).toBe(false)
    expect(afterLoad.hasC).toBe(true)

    await Effect.runPromise(ensureGrammarForExt(".ts"))
    const reloaded = await Effect.runPromise(
      withTreeSitter((state) => ({
        hasTs: state.parser.languagesByExt.has(".ts"),
        families: state.parser.grammarUseOrder.length,
      })),
    )
    expect(reloaded.hasTs).toBe(true)
    expect(reloaded.families).toBeLessThanOrEqual(MAX_HOT_GRAMMAR_FAMILIES)
  }, 120_000)
})

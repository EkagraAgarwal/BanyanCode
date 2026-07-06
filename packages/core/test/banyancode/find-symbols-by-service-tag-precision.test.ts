import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(codegraphRepoDefaultLayer)

describe("findSymbolsByServiceTag precision", () => {
  test("matches classes with canonical @org/path/Name\" tag pattern", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "file-1",
          path: "src/effect-service.ts",
          contentHash: "h1",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putNode({
          id: "svc-effect",
          fileID: "file-1",
          kind: "class",
          name: "EffectService",
          signature: "class EffectService extends Context.Service<EffectService, Interface>()",
          startLine: 1,
          endLine: 10,
          code: `export class EffectService extends Context.Service<EffectService, Interface>()("@org/Path/Effect") {}`,
        })

        const results = yield* repo.findSymbolsByServiceTag("Effect")

        expect(results.length).toBe(1)
        expect(results[0]!.name).toBe("EffectService")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("rejects classes that mention the substring outside a tag", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "file-1",
          path: "src/baz-utils.ts",
          contentHash: "h1",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putNode({
          id: "node-baz",
          fileID: "file-1",
          kind: "class",
          name: "BazUtils",
          signature: "class BazUtils",
          startLine: 1,
          endLine: 10,
          code: `class BazUtils { method() { return "Effect.gen" } }`,
        })

        const results = yield* repo.findSymbolsByServiceTag("Effect")

        expect(results.length).toBe(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("rejects doc/test nodes even if their content mentions the name", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "file-doc",
          path: "docs/effect-module.md",
          contentHash: "h1",
          language: "markdown",
          indexedAt: 1,
        })
        yield* repo.putNode({
          id: "node-doc",
          fileID: "file-doc",
          kind: "doc",
          name: "EffectModule",
          signature: undefined,
          startLine: 1,
          endLine: 10,
          code: `# Effect.gen\nA heading that mentions the name…`,
        })

        const results = yield* repo.findSymbolsByServiceTag("Effect")

        expect(results.length).toBe(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("works with multi-segment prefixes like @opencode/v2/Banyan/MemoryRepo", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "file-memory",
          path: "src/memory-repo.ts",
          contentHash: "h1",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putNode({
          id: "svc-memory",
          fileID: "file-memory",
          kind: "class",
          name: "MemoryRepoService",
          signature: "class MemoryRepoService extends Context.Service<MemoryRepoService, Interface>()",
          startLine: 1,
          endLine: 10,
          code: `export class MemoryRepoService extends Context.Service<MemoryRepoService, Interface>()("@opencode/v2/Banyan/MemoryRepo") {}`,
        })

        const results = yield* repo.findSymbolsByServiceTag("MemoryRepo")

        expect(results.length).toBe(1)
        expect(results[0]!.name).toBe("MemoryRepoService")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("rejects service classes that mention the name in their bodies but have different tags", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "file-config",
          path: "src/config.ts",
          contentHash: "h1",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putNode({
          id: "svc-config",
          fileID: "file-config",
          kind: "class",
          name: "ConfigTag",
          signature: "class ConfigTag extends Context.Service<ConfigTag, Info>()",
          startLine: 1,
          endLine: 10,
          code: `class ConfigTag extends Context.Service<ConfigTag, Info>()("@opencode/RuntimeFlags") { method() { return Effect.gen } }`,
        })

        const results = yield* repo.findSymbolsByServiceTag("Effect")

        expect(results.length).toBe(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

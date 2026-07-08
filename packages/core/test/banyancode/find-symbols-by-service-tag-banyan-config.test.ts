import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(codegraphRepoDefaultLayer)

describe("findSymbolsByServiceTag - BanyanConfigService namespace re-export", () => {
  test("resolves BanyanConfigService namespace name to @banyancode/BanyanConfig registration", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "test-file-banyan-config",
          path: "src/banyancode/banyan-config.ts",
          contentHash: "h1",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putNode({
          id: "test:class:BanyanConfig:1",
          fileID: "test-file-banyan-config",
          kind: "class",
          name: "Service",
          signature: "class Service extends Context.Service<Service, Interface>()",
          startLine: 1,
          endLine: 5,
          code: 'export class Service extends Context.Service<Service, Interface>()("@banyancode/BanyanConfig") {}',
        })

        const hits = yield* repo.findSymbolsByServiceTag("BanyanConfigService")

        expect(hits.length).toBeGreaterThan(0)
        expect(hits[0]!.id).toBe("test:class:BanyanConfig:1")
        expect(hits[0]!.name).toBe("Service")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("resolves CodegraphBuildService (non-namespace form) for symmetry", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "test-file-codegraph-build",
          path: "src/banyancode/codegraph-build-service.ts",
          contentHash: "h1",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putNode({
          id: "test:class:CodegraphBuildService:1",
          fileID: "test-file-codegraph-build",
          kind: "class",
          name: "Service",
          signature: "class Service extends Context.Service<Service, Interface>()",
          startLine: 1,
          endLine: 5,
          code: 'export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphBuildService") {}',
        })

        const hits = yield* repo.findSymbolsByServiceTag("CodegraphBuildService")

        expect(hits.length).toBeGreaterThan(0)
        expect(hits[0]!.id).toBe("test:class:CodegraphBuildService:1")
        expect(hits[0]!.name).toBe("Service")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("resolves bare tag without Service suffix (BanyanConfig)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "test-file-banyan-config-bare",
          path: "src/banyancode/banyan-config.ts",
          contentHash: "h1",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putNode({
          id: "test:class:BanyanConfig:2",
          fileID: "test-file-banyan-config-bare",
          kind: "class",
          name: "Service",
          signature: "class Service extends Context.Service<Service, Interface>()",
          startLine: 1,
          endLine: 5,
          code: 'export class Service extends Context.Service<Service, Interface>()("@banyancode/BanyanConfig") {}',
        })

        const hits = yield* repo.findSymbolsByServiceTag("BanyanConfig")

        expect(hits.length).toBeGreaterThan(0)
        expect(hits[0]!.id).toBe("test:class:BanyanConfig:2")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

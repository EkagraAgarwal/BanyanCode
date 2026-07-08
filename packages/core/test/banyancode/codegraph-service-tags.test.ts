import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(codegraphRepoDefaultLayer)

describe("codegraph_service_tags", () => {
  test("lookupByServiceTag returns node for Context.Service pattern", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.writeFileGraph({
          file: {
            id: "file-svc-test",
            path: "src/my-service.ts",
            contentHash: "h1",
            language: "typescript",
            indexedAt: Date.now(),
          },
          nodes: [
            {
              id: "node:MyService:1",
              fileID: "file-svc-test",
              kind: "class",
              name: "MyService",
              signature: "class MyService extends Context.Service<MyService, Interface>()",
              startLine: 1,
              endLine: 5,
              code: 'export class MyService extends Context.Service<MyService, Interface>()("@banyancode/MyService") {}',
            },
          ],
          edges: [],
        })

        const result = yield* repo.lookupByServiceTag("@banyancode/MyService")

        expect(result).not.toBeNull()
        expect(result!.id).toBe("node:MyService:1")
        expect(result!.name).toBe("MyService")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("findSymbolsByServiceTag uses indexed lookup first", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.writeFileGraph({
          file: {
            id: "file-indexed-test",
            path: "src/indexed-service.ts",
            contentHash: "h1",
            language: "typescript",
            indexedAt: Date.now(),
          },
          nodes: [
            {
              id: "node:IndexedService:1",
              fileID: "file-indexed-test",
              kind: "class",
              name: "IndexedService",
              signature: "class IndexedService extends Context.Service<IndexedService, Interface>()",
              startLine: 1,
              endLine: 5,
              code: 'export class IndexedService extends Context.Service<IndexedService, Interface>()("@banyancode/IndexedService") {}',
            },
          ],
          edges: [],
        })

        const hits = yield* repo.findSymbolsByServiceTag("@banyancode/IndexedService")

        expect(hits.length).toBe(1)
        expect(hits[0]!.id).toBe("node:IndexedService:1")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("5 different @banyancode/* registrations resolve via index", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const services = [
      { tag: "@banyancode/ConfigService", name: "ConfigService", id: "node:ConfigService:1" },
      { tag: "@banyancode/RepoService", name: "RepoService", id: "node:RepoService:1" },
      { tag: "@banyancode/BuildService", name: "BuildService", id: "node:BuildService:1" },
      { tag: "@banyancode/ParseService", name: "ParseService", id: "node:ParseService:1" },
      { tag: "@banyancode/IndexService", name: "IndexService", id: "node:IndexService:1" },
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.writeFileGraph({
          file: {
            id: "file-multi",
            path: "src/multi-services.ts",
            contentHash: "h1",
            language: "typescript",
            indexedAt: Date.now(),
          },
          nodes: services.map((svc) => ({
            id: svc.id,
            fileID: "file-multi",
            kind: "class",
            name: svc.name,
            signature: `class ${svc.name} extends Context.Service<${svc.name}, Interface>()`,
            startLine: 1,
            endLine: 5,
            code: `export class ${svc.name} extends Context.Service<${svc.name}, Interface>()("${svc.tag}") {}`,
          })),
          edges: [],
        })

        for (const svc of services) {
          const result = yield* repo.lookupByServiceTag(svc.tag)
          expect(result).not.toBeNull()
          expect(result!.id).toBe(svc.id)
        }
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("Service suffix and non-suffix both resolve to same canonical node", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.writeFileGraph({
          file: {
            id: "file-suffix-test",
            path: "src/suffix-test.ts",
            contentHash: "h1",
            language: "typescript",
            indexedAt: Date.now(),
          },
          nodes: [
            {
              id: "node:MyBuildService:1",
              fileID: "file-suffix-test",
              kind: "class",
              name: "MyBuildService",
              signature: "class MyBuildService extends Context.Service<MyBuildService, Interface>()",
              startLine: 1,
              endLine: 5,
              code: 'export class MyBuildService extends Context.Service<MyBuildService, Interface>()("@banyancode/MyBuildService") {}',
            },
          ],
          edges: [],
        })

        const withSuffix = yield* repo.findSymbolsByServiceTag("MyBuildService")
        const withoutSuffix = yield* repo.findSymbolsByServiceTag("MyBuild")

        expect(withSuffix.length).toBeGreaterThan(0)
        expect(withoutSuffix.length).toBeGreaterThan(0)
        expect(withSuffix[0]!.id).toBe(withoutSuffix[0]!.id)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

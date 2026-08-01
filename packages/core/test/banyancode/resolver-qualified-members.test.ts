import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "../../src/banyancode/codegraph-repo"
import { resolveGraphTargetPure } from "../../src/banyancode/symbol-resolver"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const seedGraph = (repo: CodegraphRepo.Interface) =>
  Effect.gen(function* () {
    // Source file: Context.Service<Service, Interface>() with a sibling
    // interface declaring member methods. With the parser fix, the interface
    // body produces method nodes qualified by the interface name.
    yield* repo.writeFileGraph({
      file: {
        id: "file-build",
        path: "src/banyancode/codegraph-build-service.ts",
        contentHash: "h-build",
        language: "typescript",
        indexedAt: 1,
      },
      nodes: [
        {
          id: "sym-svc",
          fileID: "file-build",
          kind: "class",
          name: "Service",
          startLine: 1,
          endLine: 5,
          code: 'class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphBuildService") {}',
        },
        {
          id: "sym-start",
          fileID: "file-build",
          kind: "method",
          name: "start",
          startLine: 10,
          endLine: 12,
          code: "readonly start: () => Effect.Effect<void>",
        },
        {
          id: "sym-cancel",
          fileID: "file-build",
          kind: "method",
          name: "cancel",
          startLine: 13,
          endLine: 15,
          code: "readonly cancel: () => Effect.Effect<void>",
        },
      ],
      edges: [],
    })

    // Caller file
    yield* repo.writeFileGraph({
      file: {
        id: "file-handler",
        path: "src/handlers/build-handler.ts",
        contentHash: "h-h",
        language: "typescript",
        indexedAt: 2,
      },
      nodes: [
        {
          id: "sym-handler",
          fileID: "file-handler",
          kind: "function",
          name: "startBuild",
          startLine: 1,
          endLine: 10,
          code: "function startBuild() {}",
        },
      ],
      edges: [
        {
          id: "e-handler-start",
          fromNodeID: "sym-handler",
          toNodeID: "sym-start",
          kind: "calls",
        },
      ],
    })
  })

const testLayer = CodegraphRepo.defaultLayer

describe("resolver — qualified Namespace.method with interface member nodes", () => {
  test("CodegraphBuildService.start resolves to the method node via qualified-split", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const tag = yield* CodegraphRepo.Service
        const repo = tag as unknown as CodegraphRepo.Interface
        yield* seedGraph(repo)

        const result = yield* resolveGraphTargetPure(repo, { target: "CodegraphBuildService.start" })
        expect(result._tag).toBe("Ok")
        if (result._tag === "Ok") {
          expect(result.value.node.name).toBe("start")
          expect(result.value.node.id).toBe("sym-start")
          expect(result.value.derivation).toBe("qualified-split")
        }
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("CodegraphBuildService.cancel resolves to the cancel method node", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const tag = yield* CodegraphRepo.Service
        const repo = tag as unknown as CodegraphRepo.Interface
        yield* seedGraph(repo)

        const result = yield* resolveGraphTargetPure(repo, { target: "CodegraphBuildService.cancel" })
        expect(result._tag).toBe("Ok")
        if (result._tag === "Ok") {
          expect(result.value.node.name).toBe("cancel")
          expect(result.value.derivation).toBe("qualified-split")
        }
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("CodegraphBuildService (parent only) resolves to the Service class via tag-fallback", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const tag = yield* CodegraphRepo.Service
        const repo = tag as unknown as CodegraphRepo.Interface
        yield* seedGraph(repo)

        const result = yield* resolveGraphTargetPure(repo, { target: "CodegraphBuildService" })
        expect(result._tag).toBe("Ok")
        if (result._tag === "Ok") {
          expect(result.value.derivation).toBe("tag-fallback")
        }
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
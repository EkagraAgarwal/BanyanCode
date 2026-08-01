import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { tmpdir } from "../fixture/tmpdir"
import {
  Service as CodegraphRepo,
  defaultLayer as codegraphRepoDefaultLayer,
} from "../../src/banyancode/codegraph-repo"
import type { Interface as CodegraphRepoInterface } from "../../src/banyancode/codegraph-repo"
import {
  Service as RepoMapService,
  defaultLayer as repoMapServiceDefaultLayer,
} from "../../src/banyancode/repo-map-service"
import type { CodegraphFile, CodegraphNode } from "../../src/banyancode/types"

process.env.BANYANCODE_ENABLE = "1"

const seed = (repo: CodegraphRepoInterface) =>
  Effect.gen(function* () {
    const fileMain: CodegraphFile = {
      id: "file-pkg-main",
      path: "packages/core/src/index.ts",
      contentHash: "h1",
      language: "typescript",
      indexedAt: 1,
    }
    const fileRoute: CodegraphFile = {
      id: "file-pkg-route",
      path: "packages/core/src/router.ts",
      contentHash: "h2",
      language: "typescript",
      indexedAt: 2,
    }
    const fileAuth: CodegraphFile = {
      id: "file-pkg-auth",
      path: "packages/auth/src/login.ts",
      contentHash: "h3",
      language: "typescript",
      indexedAt: 3,
    }
    const fileTest: CodegraphFile = {
      id: "file-pkg-test",
      path: "packages/auth/src/login.test.ts",
      contentHash: "h4",
      language: "typescript",
      indexedAt: 4,
    }
    const fileReadme: CodegraphFile = {
      id: "file-docs-readme",
      path: "README.md",
      contentHash: "h5",
      language: "markdown",
      indexedAt: 5,
    }
    yield* repo.putFile(fileMain)
    yield* repo.putFile(fileRoute)
    yield* repo.putFile(fileAuth)
    yield* repo.putFile(fileTest)
    yield* repo.putFile(fileReadme)

    yield* repo.putNode({
      id: "node-entry",
      fileID: fileMain.id,
      kind: "function",
      name: "bootstrap",
      signature: "function bootstrap(): Promise<void>",
      startLine: 1,
      endLine: 10,
      isEntrypoint: 1,
      inDegree: 8,
    })
    yield* repo.putNode({
      id: "node-route",
      fileID: fileRoute.id,
      kind: "function",
      name: "handle",
      startLine: 1,
      endLine: 25,
    })
    yield* repo.putNode({
      id: "node-login",
      fileID: fileAuth.id,
      kind: "function",
      name: "login",
      signature: "function login(user: User): Promise<Session>",
      startLine: 5,
      endLine: 15,
      isEntrypoint: 1,
      inDegree: 3,
    })
    yield* repo.putNode({
      id: "node-test",
      fileID: fileTest.id,
      kind: "function",
      name: "loginSucceeds",
      startLine: 1,
      endLine: 12,
    })

    yield* repo.setMeta({
      id: "singleton",
      schemaVersion: 1,
      graphVersion: 42,
      totalFiles: 5,
      totalNodes: 4,
      totalEdges: 0,
      graphCoverage: 1,
      graphBuiltAt: 100,
      indexedRoot: "/tmp/root",
    })
  })

const testLayer = Layer.mergeAll(codegraphRepoDefaultLayer, repoMapServiceDefaultLayer)

describe("RepoMapService", () => {
  test("overview returns package groups, entry points, kind counts, and meta", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "repo-map.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo
        const map = yield* RepoMapService
        yield* seed(repo)
        const overview = yield* map.overview({ root: "/" })

        expect(overview.graphVersion).toBe(42)
        expect(overview.totalNodes).toBe(4)
        const packageNames = overview.packages.map((pkg) => pkg.path).sort()
        expect(packageNames).toEqual([".", "packages/auth", "packages/core"])
        const auth = overview.packages.find((pkg) => pkg.path === "packages/auth")
        const core = overview.packages.find((pkg) => pkg.path === "packages/core")
        expect(auth?.nodes).toBe(2)
        expect(core?.nodes).toBe(2)
        const kinds = Object.keys(overview.fileKindCounts).sort()
        expect(kinds).toEqual(["documentation", "entrypoint", "test", "typescript"])
        const entryNames = overview.entryPoints.map((entry) => entry.name).sort()
        expect(entryNames).toContain("bootstrap")
        expect(entryNames).toContain("login")
        const bootstrap = overview.entryPoints.find((entry) => entry.name === "bootstrap")
        expect(bootstrap?.path).toBe("packages/core/src/index.ts")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("detail returns per-file symbols sorted by start line", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "repo-map.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo
        const map = yield* RepoMapService
        yield* seed(repo)
        const detail = yield* map.detail({ root: "/", path: "packages/auth/src/login.ts" })
        expect(detail.path).toBe("packages/auth/src/login.ts")
        expect(detail.symbols.length).toBe(1)
        expect(detail.symbols[0]?.name).toBe("login")
        expect(detail.symbols[0]?.signature).toBe("function login(user: User): Promise<Session>")

        const missing = yield* map.detail({ root: "/", path: "packages/missing/file.ts" })
        expect(missing.symbols.length).toBe(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("search routes through fts and joins file paths", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "repo-map.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo
        const map = yield* RepoMapService
        yield* seed(repo)
        const hits = yield* map.search({ root: "/", query: "login" })
        expect(hits.length).toBeGreaterThan(0)
        expect(hits.some((hit) => hit.name === "login" && hit.path === "packages/auth/src/login.ts")).toBe(true)
        expect(hits.every((hit) => hit.relevance >= 0)).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

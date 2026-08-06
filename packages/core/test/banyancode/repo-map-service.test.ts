import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import {
  Service as CodegraphRepo,
  defaultLayer as codegraphRepoDefaultLayer,
} from "../../src/banyancode/codegraph-repo"
import type { Interface as CodegraphRepoInterface } from "../../src/banyancode/codegraph-repo"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
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

// ---------------------------------------------------------------------------
// Phase 0 real-index regression: the real indexer stores ABSOLUTE paths
// (backslashes on Windows). detail() must resolve `./`-relative, bare
// relative, and absolute inputs against those rows, and report repo-relative
// display paths — the seeded relative rows above masked this defect.
// ---------------------------------------------------------------------------
describe("RepoMapService real-index path resolution", () => {
  const indexLayer = CodegraphIndexer.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(codegraphRepoDefaultLayer),
  )
  const mapLayer = Layer.mergeAll(codegraphRepoDefaultLayer, repoMapServiceDefaultLayer)

  const indexFixture = (root: string, dbPath: string) => {
    const dbLayer = Database.layerFromPath(dbPath)
    return Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        yield* indexer.index({ root, force: true })
      }).pipe(Effect.provide(indexLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  }

  // `index()` does not write the meta row — the codegraph build service bumps
  // it afterward. The real-index tests mirror that so repo-map can derive
  // repo-relative display paths from `meta.indexedRoot` against real stored rows.
  const bumpMeta = (repo: CodegraphRepoInterface, root: string) =>
    repo.bumpVersion({ eligibleFiles: 1, indexedRoot: root })

  const writeFixture = async (root: string) => {
    const coreSrc = path.join(root, "packages", "core", "src")
    await fs.mkdir(coreSrc, { recursive: true })
    await fs.writeFile(
      path.join(coreSrc, "index.ts"),
      ["export function bootstrap() { return 1 }", "export class Config {}"].join("\n"),
    )
    await fs.writeFile(path.join(coreSrc, "router.ts"), "export function handle() { return 3 }\n")
    const authSrc = path.join(root, "packages", "auth", "src")
    await fs.mkdir(authSrc, { recursive: true })
    await fs.writeFile(path.join(authSrc, "login.ts"), "export function login(user: unknown) { return user }\n")
  }

  test("detail resolves ./relative, bare relative, and absolute queries against absolute stored paths", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "repo-map.db")
    await writeFixture(tmp.path)
    await indexFixture(tmp.path, dbPath)
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo
        yield* bumpMeta(repo, tmp.path)
        const map = yield* RepoMapService

        const viaDotSlash = yield* map.detail({ root: tmp.path, path: "./packages/core/src/index.ts" })
        expect(viaDotSlash.found).toBe(true)
        expect(viaDotSlash.path).toBe("packages/core/src/index.ts")
        expect(viaDotSlash.symbols.map((s) => s.name).sort()).toEqual(["Config", "bootstrap"])

        const viaRelative = yield* map.detail({ root: tmp.path, path: "packages/core/src/index.ts" })
        expect(viaRelative.found).toBe(true)
        expect(viaRelative.path).toBe("packages/core/src/index.ts")

        const viaAbsolute = yield* map.detail({ root: tmp.path, path: path.join(tmp.path, "packages", "core", "src", "index.ts") })
        expect(viaAbsolute.found).toBe(true)
        expect(viaAbsolute.path).toBe("packages/core/src/index.ts")
        expect(viaAbsolute.symbols.map((s) => s.name).sort()).toEqual(["Config", "bootstrap"])

        const missing = yield* map.detail({ root: tmp.path, path: "packages/missing/file.ts" })
        expect(missing.found).toBe(false)
        expect(missing.symbols.length).toBe(0)
      }).pipe(Effect.provide(mapLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("detail distinguishes a symbol-less file (found, no symbols) from a missing file (not found)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "repo-map.db")
    await writeFixture(tmp.path)
    await fs.writeFile(path.join(tmp.path, "packages", "core", "src", "placeholder.ts"), "// no symbols here\n")
    await indexFixture(tmp.path, dbPath)
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo
        yield* bumpMeta(repo, tmp.path)
        const map = yield* RepoMapService

        const symbolLess = yield* map.detail({ root: tmp.path, path: "packages/core/src/placeholder.ts" })
        expect(symbolLess.found).toBe(true)
        expect(symbolLess.symbols.length).toBe(0)

        const absent = yield* map.detail({ root: tmp.path, path: "packages/core/src/nope.ts" })
        expect(absent.found).toBe(false)
      }).pipe(Effect.provide(mapLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("overview groups absolute stored paths into packages and renders repo-relative entry points", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "repo-map.db")
    await writeFixture(tmp.path)
    await indexFixture(tmp.path, dbPath)
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo
        yield* bumpMeta(repo, tmp.path)
        const map = yield* RepoMapService
        const overview = yield* map.overview({ root: tmp.path })

        const packageNames = overview.packages.map((pkg) => pkg.path).sort()
        expect(packageNames).toEqual(["packages/auth", "packages/core"])
        const core = overview.packages.find((pkg) => pkg.path === "packages/core")
        expect(core?.files).toBe(2)
        expect(overview.entryPoints.every((entry) => !entry.path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(entry.path))).toBe(true)
        expect(overview.entryPoints.some((entry) => entry.name === "bootstrap" && entry.path === "packages/core/src/index.ts")).toBe(true)
      }).pipe(Effect.provide(mapLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

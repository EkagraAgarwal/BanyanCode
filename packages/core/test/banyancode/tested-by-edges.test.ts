import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"

process.env.BANYANCODE_ENABLE = "1"

const buildServiceLayer = () =>
  CodegraphIndexer.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(codegraphRepoDefaultLayer),
  )

describe("tested_by edges", () => {
  test("import match creates edge", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await fs.mkdir(path.join(tmp.path, "src"), { recursive: true })
    await fs.mkdir(path.join(tmp.path, "test"), { recursive: true })
    await fs.writeFile(
      path.join(tmp.path, "src/module.ts"),
      "export function foo() { return 42 }\n",
    )
    await fs.writeFile(
      path.join(tmp.path, "test/module.test.ts"),
      'import { foo } from "./module"\ntest("foo", () => { expect(foo()).toBe(42) })\n',
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const indexer = yield* CodegraphIndexer.Service
        yield* indexer.index({ root: tmp.path })
        const repo = yield* CodegraphRepo.Service
        const allNodes = yield* repo.listAllNodes()
        const fooNode = allNodes.find((n) => n.name === "foo")
        expect(fooNode).toBeDefined()
        const edges = yield* repo.listAllEdges()
        const testedByEdges = edges.filter((e) => e.kind === "tested_by")
        expect(testedByEdges.length).toBeGreaterThanOrEqual(1)
        const fooEdge = testedByEdges.find((e) => e.fromNodeID === fooNode!.id)
        expect(fooEdge).toBeDefined()
      }).pipe(
        Effect.provide(buildServiceLayer()),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("name-only match without import does NOT create edge", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await fs.mkdir(path.join(tmp.path, "src"), { recursive: true })
    await fs.mkdir(path.join(tmp.path, "test"), { recursive: true })
    await fs.writeFile(
      path.join(tmp.path, "src/module.ts"),
      "export function bar() { return 42 }\n",
    )
    await fs.writeFile(
      path.join(tmp.path, "test/standalone.test.ts"),
      'import { test } from "bun:test"\ntest("standalone", () => { /* bar is mentioned but not imported */ })\n',
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const indexer = yield* CodegraphIndexer.Service
        yield* indexer.index({ root: tmp.path })
        const repo = yield* CodegraphRepo.Service
        const allNodes = yield* repo.listAllNodes()
        const barNode = allNodes.find((n) => n.name === "bar")
        expect(barNode).toBeDefined()
        const edges = yield* repo.listAllEdges()
        const testedByEdges = edges.filter((e) => e.kind === "tested_by")
        const barEdge = testedByEdges.find((e) => e.fromNodeID === barNode!.id)
        expect(barEdge).toBeUndefined()
      }).pipe(
        Effect.provide(buildServiceLayer()),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("multiple candidates + call match still creates edge when exactly one candidate", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await fs.mkdir(path.join(tmp.path, "src"), { recursive: true })
    await fs.mkdir(path.join(tmp.path, "test"), { recursive: true })
    await fs.writeFile(
      path.join(tmp.path, "src/alone.ts"),
      "export function uniqueName() { return 42 }\n",
    )
    await fs.writeFile(
      path.join(tmp.path, "test/alone.test.ts"),
      'test("uniqueName call", () => { uniqueName() })\n',
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const indexer = yield* CodegraphIndexer.Service
        yield* indexer.index({ root: tmp.path })
        const repo = yield* CodegraphRepo.Service
        const allNodes = yield* repo.listAllNodes()
        const uniqueNode = allNodes.find((n) => n.name === "uniqueName")
        expect(uniqueNode).toBeDefined()
        const edges = yield* repo.listAllEdges()
        const testedByEdges = edges.filter((e) => e.kind === "tested_by")
        const uniqueEdge = testedByEdges.find((e) => e.fromNodeID === uniqueNode!.id)
        expect(uniqueEdge).toBeDefined()
      }).pipe(
        Effect.provide(buildServiceLayer()),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("multiple candidates + name match without import does NOT create edge", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await fs.mkdir(path.join(tmp.path, "src"), { recursive: true })
    await fs.mkdir(path.join(tmp.path, "test"), { recursive: true })
    await fs.writeFile(
      path.join(tmp.path, "src/a.ts"),
      "export function dupName() { return 1 }\n",
    )
    await fs.writeFile(
      path.join(tmp.path, "src/b.ts"),
      "export function dupName() { return 2 }\n",
    )
    await fs.writeFile(
      path.join(tmp.path, "test/dup.test.ts"),
      'test("dupName", () => { /* no import, two candidates */ })\n',
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const indexer = yield* CodegraphIndexer.Service
        yield* indexer.index({ root: tmp.path })
        const repo = yield* CodegraphRepo.Service
        const allNodes = yield* repo.listAllNodes()
        const dupNodes = allNodes.filter((n) => n.name === "dupName")
        expect(dupNodes.length).toBe(2)
        const edges = yield* repo.listAllEdges()
        const testedByEdges = edges.filter((e) => e.kind === "tested_by")
        const dupEdges = testedByEdges.filter(
          (e) => e.fromNodeID === dupNodes[0]!.id || e.fromNodeID === dupNodes[1]!.id,
        )
        expect(dupEdges.length).toBe(0)
      }).pipe(
        Effect.provide(buildServiceLayer()),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("same-file test nodes excluded", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await fs.mkdir(path.join(tmp.path, "src"), { recursive: true })
    await fs.writeFile(
      path.join(tmp.path, "src/self.test.ts"),
      'import { test } from "bun:test"\nfunction helper() {}\ntest("helper", () => { helper() })\n',
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const indexer = yield* CodegraphIndexer.Service
        yield* indexer.index({ root: tmp.path })
        const repo = yield* CodegraphRepo.Service
        const allNodes = yield* repo.listAllNodes()
        const helperNode = allNodes.find((n) => n.name === "helper")
        expect(helperNode).toBeDefined()
        const edges = yield* repo.listAllEdges()
        const testedByEdges = edges.filter((e) => e.kind === "tested_by")
        const selfEdge = testedByEdges.find((e) => e.fromNodeID === helperNode!.id)
        expect(selfEdge).toBeUndefined()
      }).pipe(
        Effect.provide(buildServiceLayer()),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })
})

describe("configured_by edges", () => {
  test("requires literal config-basename reference", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await fs.mkdir(path.join(tmp.path, "src"), { recursive: true })
    await fs.writeFile(
      path.join(tmp.path, "src/package.json"),
      '{ "name": "test", "scripts": { "build": "tsc" } }\n',
    )
    await fs.writeFile(
      path.join(tmp.path, "src/code.ts"),
      'import pkg from "./package.json"\nexport function main() { console.log(pkg.name) }\n',
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const indexer = yield* CodegraphIndexer.Service
        yield* indexer.index({ root: tmp.path })
        const repo = yield* CodegraphRepo.Service
        const edges = yield* repo.listAllEdges()
        const configuredByEdges = edges.filter((e) => e.kind === "configured_by")
        expect(configuredByEdges.length).toBeGreaterThanOrEqual(1)
      }).pipe(
        Effect.provide(buildServiceLayer()),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("non-config file without literal config basename does NOT get edge", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await fs.mkdir(path.join(tmp.path, "src"), { recursive: true })
    await fs.writeFile(
      path.join(tmp.path, "src/config.json"),
      '{ "name": "test" }\n',
    )
    await fs.writeFile(
      path.join(tmp.path, "src/no-ref.ts"),
      "export function noRefFunc() { const x = 42 }\n",
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const indexer = yield* CodegraphIndexer.Service
        yield* indexer.index({ root: tmp.path })
        const repo = yield* CodegraphRepo.Service
        const allNodes = yield* repo.listAllNodes()
        const noRefNode = allNodes.find((n) => n.name === "noRefFunc")
        expect(noRefNode).toBeDefined()
        const edges = yield* repo.listAllEdges()
        const configuredByEdges = edges.filter((e) => e.kind === "configured_by")
        const noRefEdge = configuredByEdges.find((e) => e.fromNodeID === noRefNode!.id)
        expect(noRefEdge).toBeUndefined()
      }).pipe(
        Effect.provide(buildServiceLayer()),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("file outside config directory does NOT get edge", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await fs.mkdir(path.join(tmp.path, "src"), { recursive: true })
    await fs.mkdir(path.join(tmp.path, "other"), { recursive: true })
    await fs.writeFile(
      path.join(tmp.path, "src/config.json"),
      '{ "setting": true }\n',
    )
    await fs.writeFile(
      path.join(tmp.path, "other/unrelated.ts"),
      'import cfg from "../src/config.json"\nexport function unrelatedFunc() { console.log(cfg) }\n',
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const indexer = yield* CodegraphIndexer.Service
        yield* indexer.index({ root: tmp.path })
        const repo = yield* CodegraphRepo.Service
        const allNodes = yield* repo.listAllNodes()
        const unrelatedNode = allNodes.find((n) => n.name === "unrelatedFunc")
        expect(unrelatedNode).toBeDefined()
        const edges = yield* repo.listAllEdges()
        const configuredByEdges = edges.filter((e) => e.kind === "configured_by")
        const outDirEdge = configuredByEdges.find((e) => e.fromNodeID === unrelatedNode!.id)
        expect(outDirEdge).toBeUndefined()
      }).pipe(
        Effect.provide(buildServiceLayer()),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })
})

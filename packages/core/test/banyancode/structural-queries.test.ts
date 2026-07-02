import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { Service as StructuralQueries, layer as structuralQueriesLayer, defaultLayer as structuralQueriesDefaultLayer } from "../../src/banyancode/structural-queries"

process.env.BANYANCODE_ENABLE = "1"

describe("StructuralQueries", () => {
  describe("findHTTPRoutes", () => {
    test("finds Express routes in TypeScript", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const dbLayer = Database.layerFromPath(dbPath)

      // Create a test file with Express routes
      const routeFile = path.join(tmp.path, "routes.ts")
      await fs.writeFile(
        routeFile,
        `
import express from "express"
const app = express()

app.get("/users", (req, res) => {
  res.json({ users: [] })
})

app.post("/users", (req, res) => {
  res.status(201).json({ created: true })
})

app.put("/users/:id", (req, res) => {
  res.json({ updated: true })
})

app.delete("/users/:id", (req, res) => {
  res.status(204).send()
})

export default app
`,
      )

      const indexerLayer = CodegraphIndexer.layer.pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(codegraphRepoDefaultLayer),
      )

      const queriesLayer = structuralQueriesLayer.pipe(
        Layer.provide(codegraphRepoDefaultLayer),
      )

      // Index the file
      await Effect.runPromise(
        Effect.gen(function* () {
          const indexer = yield* CodegraphIndexer.Service
          yield* indexer.index({ root: tmp.path, force: true })
        }).pipe(Effect.provide(indexerLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      // Get the file ID
      const fileId = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          const file = yield* repo.getFileByPath(routeFile)
          return file?.id
        }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      expect(fileId).toBeDefined()

      // Query for HTTP routes
      const routes = await Effect.runPromise(
        Effect.gen(function* () {
          const queries = yield* StructuralQueries
          return yield* queries.findHTTPRoutes({ file: fileId! })
        }).pipe(Effect.provide(queriesLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      expect(routes.length).toBeGreaterThanOrEqual(4)
      const methods = routes.map((r) => r.name)
      expect(methods).toContain("GET /users")
      expect(methods).toContain("POST /users")
      expect(methods).toContain("PUT /users/:id")
      expect(methods).toContain("DELETE /users/:id")
    })

    test("returns empty array for non-TypeScript language (Python)", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const dbLayer = Database.layerFromPath(dbPath)

      const queriesLayer = structuralQueriesLayer.pipe(
        Layer.provide(codegraphRepoDefaultLayer),
      )

      const routes = await Effect.runPromise(
        Effect.gen(function* () {
          const queries = yield* StructuralQueries
          return yield* queries.findHTTPRoutes({ language: "python" })
        }).pipe(Effect.provide(queriesLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      expect(routes).toEqual([])
    })
  })

  describe("findAsyncFunctions", () => {
    test("finds async functions in TypeScript", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const dbLayer = Database.layerFromPath(dbPath)

      const asyncFile = path.join(tmp.path, "async.ts")
      await fs.writeFile(
        asyncFile,
        `
async function fetchData(): Promise<Data> {
  return await fetch("/api/data").then(r => r.json())
}

function syncFunction() {
  return "sync"
}

const getUser = async (id: string) => {
  return await db.users.findById(id)
}

const syncArrow = () => "sync"
const asyncArrow = async () => Promise.resolve(42)
`,
      )

      const indexerLayer = CodegraphIndexer.layer.pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(codegraphRepoDefaultLayer),
      )

      const queriesLayer = structuralQueriesLayer.pipe(
        Layer.provide(codegraphRepoDefaultLayer),
      )

      // Index the file
      await Effect.runPromise(
        Effect.gen(function* () {
          const indexer = yield* CodegraphIndexer.Service
          yield* indexer.index({ root: tmp.path, force: true })
        }).pipe(Effect.provide(indexerLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      // Get the file ID
      const fileId = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          const file = yield* repo.getFileByPath(asyncFile)
          return file?.id
        }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      expect(fileId).toBeDefined()

      // Query for async functions
      const asyncFunctions = await Effect.runPromise(
        Effect.gen(function* () {
          const queries = yield* StructuralQueries
          return yield* queries.findAsyncFunctions({ file: fileId! })
        }).pipe(Effect.provide(queriesLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      const names = asyncFunctions.map((f) => f.name)
      expect(names).toContain("fetchData")
      expect(names).toContain("getUser")
      expect(names).toContain("asyncArrow")
      expect(names).not.toContain("syncFunction")
      expect(names).not.toContain("syncArrow")
    })

    test("returns empty array for Python (stub)", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const dbLayer = Database.layerFromPath(dbPath)

      const queriesLayer = structuralQueriesLayer.pipe(
        Layer.provide(codegraphRepoDefaultLayer),
      )

      const funcs = await Effect.runPromise(
        Effect.gen(function* () {
          const queries = yield* StructuralQueries
          return yield* queries.findAsyncFunctions({ language: "python" })
        }).pipe(Effect.provide(queriesLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      expect(funcs).toEqual([])
    })
  })

  describe("findRecursiveFunctions", () => {
    test("finds recursive functions in TypeScript", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const dbLayer = Database.layerFromPath(dbPath)

      const recursiveFile = path.join(tmp.path, "recursive.ts")
      await fs.writeFile(
        recursiveFile,
        `
function factorial(n: number): number {
  if (n <= 1) return 1
  return n * factorial(n - 1)
}

function fibonacci(n: number): number {
  if (n <= 1) return n
  return fibonacci(n - 1) + fibonacci(n - 2)
}

function sum(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr[0] + sum(arr.slice(1))
}

function helper(): number {
  return "not recursive"
}
`,
      )

      const indexerLayer = CodegraphIndexer.layer.pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(codegraphRepoDefaultLayer),
      )

      const queriesLayer = structuralQueriesLayer.pipe(
        Layer.provide(codegraphRepoDefaultLayer),
      )

      // Index the file
      await Effect.runPromise(
        Effect.gen(function* () {
          const indexer = yield* CodegraphIndexer.Service
          yield* indexer.index({ root: tmp.path, force: true })
        }).pipe(Effect.provide(indexerLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      // Get the file ID
      const fileId = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          const file = yield* repo.getFileByPath(recursiveFile)
          return file?.id
        }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      expect(fileId).toBeDefined()

      // Query for recursive functions
      const recursiveFuncs = await Effect.runPromise(
        Effect.gen(function* () {
          const queries = yield* StructuralQueries
          return yield* queries.findRecursiveFunctions({ file: fileId! })
        }).pipe(Effect.provide(queriesLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      const names = recursiveFuncs.map((f) => f.name)
      expect(names).toContain("factorial")
      expect(names).toContain("fibonacci")
      expect(names).toContain("sum")
      expect(names).not.toContain("helper")
    })
  })

  describe("findImplementations", () => {
    test("finds classes that implement an interface", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const dbLayer = Database.layerFromPath(dbPath)

      const implFile = path.join(tmp.path, "impl.ts")
      await fs.writeFile(
        implFile,
        `
interface Animal {
  name: string
  speak(): void
}

class Dog implements Animal {
  name = "dog"
  speak() {
    console.log("woof")
  }
}

class Cat implements Animal {
  name = "cat"
  speak() {
    console.log("meow")
  }
}

class NotAnAnimal {
  name = "rock"
}
`,
      )

      const indexerLayer = CodegraphIndexer.layer.pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(codegraphRepoDefaultLayer),
      )

      const queriesLayer = structuralQueriesLayer.pipe(
        Layer.provide(codegraphRepoDefaultLayer),
      )

      // Index the file
      await Effect.runPromise(
        Effect.gen(function* () {
          const indexer = yield* CodegraphIndexer.Service
          yield* indexer.index({ root: tmp.path, force: true })
        }).pipe(Effect.provide(indexerLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      // Get the file ID
      const fileId = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          const file = yield* repo.getFileByPath(implFile)
          return file?.id
        }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      expect(fileId).toBeDefined()

      // Query for implementations of Animal
      const implementations = await Effect.runPromise(
        Effect.gen(function* () {
          const queries = yield* StructuralQueries
          return yield* queries.findImplementations({ interfaceName: "Animal", file: fileId! })
        }).pipe(Effect.provide(queriesLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      const names = implementations.map((n) => n.name)
      expect(names).toContain("Dog")
      expect(names).toContain("Cat")
      expect(names).not.toContain("NotAnAnimal")
    })

    test("finds classes that extend a base class", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const dbLayer = Database.layerFromPath(dbPath)

      const extFile = path.join(tmp.path, "extend.ts")
      await fs.writeFile(
        extFile,
        `
class BaseController {
  handle() {}
}

class UserController extends BaseController {
  create() {}
}

class ProductController extends BaseController {
  update() {}
}

class Helper {
  assist() {}
}
`,
      )

      const indexerLayer = CodegraphIndexer.layer.pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(codegraphRepoDefaultLayer),
      )

      const queriesLayer = structuralQueriesLayer.pipe(
        Layer.provide(codegraphRepoDefaultLayer),
      )

      // Index the file
      await Effect.runPromise(
        Effect.gen(function* () {
          const indexer = yield* CodegraphIndexer.Service
          yield* indexer.index({ root: tmp.path, force: true })
        }).pipe(Effect.provide(indexerLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      // Get the file ID
      const fileId = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          const file = yield* repo.getFileByPath(extFile)
          return file?.id
        }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      expect(fileId).toBeDefined()

      // Query for subclasses of BaseController
      const subclasses = await Effect.runPromise(
        Effect.gen(function* () {
          const queries = yield* StructuralQueries
          return yield* queries.findImplementations({ interfaceName: "BaseController", file: fileId! })
        }).pipe(Effect.provide(queriesLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      const names = subclasses.map((n) => n.name)
      expect(names).toContain("UserController")
      expect(names).toContain("ProductController")
      expect(names).not.toContain("Helper")
    })
  })

  describe("findOverrides", () => {
    test("finds methods with a specific name", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const dbLayer = Database.layerFromPath(dbPath)

      const methodFile = path.join(tmp.path, "methods.ts")
      await fs.writeFile(
        methodFile,
        `
class Repository {
  findById(id: string) {}
  findAll() {}
  save(entity: unknown) {}
}

class UserRepository extends Repository {
  findById(id: string) {
    return db.users.findById(id)
  }

  delete(id: string) {}
}

class ProductRepository extends Repository {
  findById(id: string) {
    return db.products.findById(id)
  }
}
`,
      )

      const indexerLayer = CodegraphIndexer.layer.pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(codegraphRepoDefaultLayer),
      )

      const queriesLayer = structuralQueriesLayer.pipe(
        Layer.provide(codegraphRepoDefaultLayer),
      )

      // Index the file
      await Effect.runPromise(
        Effect.gen(function* () {
          const indexer = yield* CodegraphIndexer.Service
          yield* indexer.index({ root: tmp.path, force: true })
        }).pipe(Effect.provide(indexerLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      // Get the file ID
      const fileId = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          const file = yield* repo.getFileByPath(methodFile)
          return file?.id
        }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      expect(fileId).toBeDefined()

      // Query for methods named findById
      const methods = await Effect.runPromise(
        Effect.gen(function* () {
          const queries = yield* StructuralQueries
          return yield* queries.findOverrides({ methodName: "findById", file: fileId! })
        }).pipe(Effect.provide(queriesLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      const names = methods.map((m) => m.name)
      expect(names.filter((n) => n === "findById").length).toBeGreaterThanOrEqual(3)
    })
  })

  describe("language support", () => {
    test("Python returns empty array (not implemented)", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const dbLayer = Database.layerFromPath(dbPath)

      const queriesLayer = structuralQueriesLayer.pipe(
        Layer.provide(codegraphRepoDefaultLayer),
      )

      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const queries = yield* StructuralQueries
          const [impls, overrides, recursive, async] = yield* Effect.all([
            queries.findImplementations({ interfaceName: "Test", language: "python" }),
            queries.findOverrides({ methodName: "test", language: "python" }),
            queries.findRecursiveFunctions({ language: "python" }),
            queries.findAsyncFunctions({ language: "python" }),
          ])
          return { impls, overrides, recursive, async }
        }).pipe(Effect.provide(queriesLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      expect(results.impls).toEqual([])
      expect(results.overrides).toEqual([])
      // Python async def IS implemented
      expect(results.async).toEqual([])
      expect(results.recursive).toEqual([])
    })

    test("Go returns empty array (not implemented)", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const dbLayer = Database.layerFromPath(dbPath)

      const queriesLayer = structuralQueriesLayer.pipe(
        Layer.provide(codegraphRepoDefaultLayer),
      )

      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const queries = yield* StructuralQueries
          const [impls, overrides, recursive, async] = yield* Effect.all([
            queries.findImplementations({ interfaceName: "Test", language: "go" }),
            queries.findOverrides({ methodName: "test", language: "go" }),
            queries.findRecursiveFunctions({ language: "go" }),
            queries.findAsyncFunctions({ language: "go" }),
          ])
          return { impls, overrides, recursive, async }
        }).pipe(Effect.provide(queriesLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      expect(results.impls).toEqual([])
      expect(results.overrides).toEqual([])
      expect(results.recursive).toEqual([])
      expect(results.async).toEqual([])
    })

    test("Rust returns empty array (not implemented)", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const dbLayer = Database.layerFromPath(dbPath)

      const queriesLayer = structuralQueriesLayer.pipe(
        Layer.provide(codegraphRepoDefaultLayer),
      )

      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const queries = yield* StructuralQueries
          const [impls, overrides, recursive, async, routes] = yield* Effect.all([
            queries.findImplementations({ interfaceName: "Test", language: "rust" }),
            queries.findOverrides({ methodName: "test", language: "rust" }),
            queries.findRecursiveFunctions({ language: "rust" }),
            queries.findAsyncFunctions({ language: "rust" }),
            queries.findHTTPRoutes({ language: "rust" }),
          ])
          return { impls, overrides, recursive, async, routes }
        }).pipe(Effect.provide(queriesLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      expect(results.impls).toEqual([])
      expect(results.overrides).toEqual([])
      expect(results.recursive).toEqual([])
      expect(results.async).toEqual([])
      expect(results.routes).toEqual([])
    })

    test("Java returns empty array (not implemented)", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const dbLayer = Database.layerFromPath(dbPath)

      const queriesLayer = structuralQueriesLayer.pipe(
        Layer.provide(codegraphRepoDefaultLayer),
      )

      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const queries = yield* StructuralQueries
          const [impls, overrides, recursive, async, routes] = yield* Effect.all([
            queries.findImplementations({ interfaceName: "Test", language: "java" }),
            queries.findOverrides({ methodName: "test", language: "java" }),
            queries.findRecursiveFunctions({ language: "java" }),
            queries.findAsyncFunctions({ language: "java" }),
            queries.findHTTPRoutes({ language: "java" }),
          ])
          return { impls, overrides, recursive, async, routes }
        }).pipe(Effect.provide(queriesLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      expect(results.impls).toEqual([])
      expect(results.overrides).toEqual([])
      expect(results.recursive).toEqual([])
      expect(results.async).toEqual([])
      expect(results.routes).toEqual([])
    })
  })
})

import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { tmpdir } from "../fixture/tmpdir"

describe("CodegraphRepo.putNodes (batched)", () => {
  test("inserts many nodes in chunks of 200", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* DatabaseMigration.apply(db)
      const repo = yield* CodegraphRepo.Service
      yield* repo.putFile({
        id: "f1",
        path: "/test/file.ts",
        contentHash: "abc",
        language: "typescript",
        indexedAt: Date.now(),
      })
      const nodes = Array.from({ length: 450 }, (_, i) => ({
        id: `n${i}`,
        fileID: "f1",
        kind: "function" as const,
        name: `f${i}`,
        startLine: i,
        endLine: i,
      }))
      yield* repo.putNodes(nodes)
      return yield* repo.countNodes()
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
    if (Exit.isFailure(exit)) console.error("cause:", Cause.pretty(exit.cause))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBe(450)
    }
  })

  test("upsert on conflict replaces existing node", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* DatabaseMigration.apply(db)
      const repo = yield* CodegraphRepo.Service
      yield* repo.putFile({
        id: "f1",
        path: "/test/file.ts",
        contentHash: "abc",
        language: "typescript",
        indexedAt: Date.now(),
      })
      yield* repo.putNode({ id: "n1", fileID: "f1", kind: "function", name: "old", startLine: 0, endLine: 0 })
      yield* repo.putNodes([{ id: "n1", fileID: "f1", kind: "class", name: "new", startLine: 5, endLine: 10 }])
      const node = yield* repo.getNode("n1")
      return yield* repo.countNodes().pipe(Effect.map((c) => ({ count: c, node })))
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
    if (Exit.isFailure(exit)) console.error("cause:", Cause.pretty(exit.cause))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.count).toBe(1)
      expect(exit.value.node?.kind).toBe("class")
      expect(exit.value.node?.name).toBe("new")
      expect(exit.value.node?.startLine).toBe(5)
    }
  })

  test("empty array is a no-op", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* DatabaseMigration.apply(db)
      const repo = yield* CodegraphRepo.Service
      yield* repo.putNodes([])
      return yield* repo.countNodes()
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
    if (Exit.isFailure(exit)) console.error("cause:", Cause.pretty(exit.cause))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBe(0)
    }
  })
})

describe("CodegraphRepo.putEdges (batched)", () => {
  test("inserts many edges in chunks of 200", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* DatabaseMigration.apply(db)
      const repo = yield* CodegraphRepo.Service
      // Insert a single file and many nodes so FK constraints on edges resolve.
      yield* repo.putFile({
        id: "f1",
        path: "/test/file.ts",
        contentHash: "abc",
        language: "typescript",
        indexedAt: Date.now(),
      })
      const nodeCount = 450
      for (let i = 0; i < nodeCount; i++) {
        yield* repo.putNode({
          id: `n${i}`,
          fileID: "f1",
          kind: "function",
          name: `f${i}`,
          startLine: i,
          endLine: i,
        })
      }
      const edges = Array.from({ length: nodeCount }, (_, i) => ({
        id: `e${i}`,
        fromNodeID: `n${i}`,
        toNodeID: `n${(i + 1) % nodeCount}`,
        kind: "references" as const,
      }))
      yield* repo.putEdges(edges)
      return yield* repo.countEdges()
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
    if (Exit.isFailure(exit)) console.error("cause:", Cause.pretty(exit.cause))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBe(450)
    }
  })

  test("upsert on conflict replaces existing edge", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* DatabaseMigration.apply(db)
      const repo = yield* CodegraphRepo.Service
      yield* repo.putFile({
        id: "f1",
        path: "/test/file.ts",
        contentHash: "abc",
        language: "typescript",
        indexedAt: Date.now(),
      })
      for (const id of ["a1", "b1", "b2", "b3", "a2"]) {
        yield* repo.putNode({
          id,
          fileID: "f1",
          kind: "function",
          name: id,
          startLine: 0,
          endLine: 0,
        })
      }
      yield* repo.putEdge({ id: "e1", fromNodeID: "a1", toNodeID: "b1", kind: "calls" })
      yield* repo.putEdge({ id: "e1", fromNodeID: "a1", toNodeID: "b2", kind: "references" })
      yield* repo.putEdges([{ id: "e1", fromNodeID: "a2", toNodeID: "b3", kind: "extends" }])
      const edge = yield* repo.getEdge("e1")
      return yield* repo.countEdges().pipe(Effect.map((c) => ({ count: c, edge })))
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
    if (Exit.isFailure(exit)) console.error("cause:", Cause.pretty(exit.cause))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.count).toBe(1)
      expect(exit.value.edge?.fromNodeID).toBe("a2")
      expect(exit.value.edge?.toNodeID).toBe("b3")
      expect(exit.value.edge?.kind).toBe("extends")
    }
  })

  test("empty array is a no-op", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* DatabaseMigration.apply(db)
      const repo = yield* CodegraphRepo.Service
      yield* repo.putEdges([])
      return yield* repo.countEdges()
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
    if (Exit.isFailure(exit)) console.error("cause:", Cause.pretty(exit.cause))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBe(0)
    }
  })
})
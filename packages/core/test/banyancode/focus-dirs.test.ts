import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { RepositoryIntelligence, defaultLayer as repositoryIntelligenceDefaultLayer } from "../../src/banyancode/repository-intelligence"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(
  repositoryIntelligenceDefaultLayer,
  CodegraphRepo.defaultLayer,
)

describe("focusDirs filtering", () => {
  test("focusDirs filters candidates to the focused package", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-opencode", path: "packages/opencode/src/tool.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "file-core", path: "packages/core/src/tool.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })

        yield* repo.putNode({ id: "node-opencode", fileID: "file-opencode", kind: "function", name: "TaskTool", signature: "function TaskTool()", startLine: 1, endLine: 10 })
        yield* repo.putNode({ id: "node-core", fileID: "file-core", kind: "function", name: "TaskTool", signature: "function TaskTool()", startLine: 1, endLine: 10 })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.query({
          query: "TaskTool",
          workspace: { worktree: "/fake", focusDirs: ["packages/opencode"] },
        })

        expect(result.status).toBe("success")
        expect(result.symbols.length).toBe(1)
        expect(result.symbols[0]!.id).toBe("node-opencode")
        expect(result.ambiguity).toBeUndefined()
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("focusDirs fallback when zero candidates match", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-opencode", path: "packages/opencode/src/tool.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "node-opencode", fileID: "file-opencode", kind: "function", name: "TaskTool", signature: "function TaskTool()", startLine: 1, endLine: 10 })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.query({
          query: "TaskTool",
          workspace: { worktree: "/fake", focusDirs: ["packages/nonexistent"] },
        })

        expect(result.status).toBe("success")
        expect(result.symbols.length).toBe(1)
        expect(result.symbols[0]!.id).toBe("node-opencode")
        expect(result.ambiguity).toEqual({ total: 1, kept: 0 })
        const focusDiag = result.diagnostics?.find((d) => d.kind === "ambiguous-symbol")
        expect(focusDiag).toBeDefined()
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("no focusDirs + multiple exact matches returns all + ambiguous-symbol diagnostic", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-a", path: "packages/opencode/src/tool.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "file-b", path: "packages/core/src/tool.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })

        yield* repo.putNode({ id: "node-a", fileID: "file-a", kind: "function", name: "TaskTool", signature: "function TaskTool()", startLine: 1, endLine: 10 })
        yield* repo.putNode({ id: "node-b", fileID: "file-b", kind: "function", name: "TaskTool", signature: "function TaskTool()", startLine: 1, endLine: 10 })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.query({ query: "TaskTool" })

        expect(result.status).toBe("success")
        expect(result.symbols.length).toBe(2)
        expect(result.ambiguity).toEqual({ total: 2, kept: 2 })
        const diag = result.diagnostics?.find((d) => d.kind === "ambiguous-symbol")
        expect(diag).toBeDefined()
        expect(diag!.message).toContain("pass focusDirs to disambiguate")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("no focusDirs + only product-package matches keeps all product matches", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-opencode", path: "packages/opencode/src/util.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "file-core", path: "packages/core/src/util.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })

        yield* repo.putNode({ id: "node-opencode", fileID: "file-opencode", kind: "function", name: "SharedHelper", signature: "function SharedHelper()", startLine: 1, endLine: 10 })
        yield* repo.putNode({ id: "node-core", fileID: "file-core", kind: "function", name: "SharedHelper", signature: "function SharedHelper()", startLine: 1, endLine: 10 })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.query({ query: "SharedHelper" })

        expect(result.status).toBe("success")
        expect(result.symbols.length).toBe(2)
        expect(result.symbols.some((n) => n.id === "node-opencode")).toBe(true)
        expect(result.symbols.some((n) => n.id === "node-core")).toBe(true)
        expect(result.ambiguity).toEqual({ total: 2, kept: 2 })
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("no focusDirs + only UI-package matches keeps those (no promotion)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-web", path: "packages/web/src/widget.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })

        yield* repo.putNode({ id: "node-web", fileID: "file-web", kind: "function", name: "WidgetHelper", signature: "function WidgetHelper()", startLine: 1, endLine: 10 })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.query({ query: "WidgetHelper" })

        expect(result.status).toBe("success")
        expect(result.symbols.length).toBe(1)
        expect(result.symbols[0]!.id).toBe("node-web")
        expect(result.ambiguity).toBeUndefined()
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("no focusDirs + both product and UI matches keeps only product matches", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-opencode", path: "packages/opencode/src/shared.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "file-web", path: "packages/web/src/shared.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })
        yield* repo.putFile({ id: "file-desktop", path: "packages/desktop/src/shared.ts", contentHash: "h3", language: "typescript", indexedAt: 3 })

        yield* repo.putNode({ id: "node-opencode", fileID: "file-opencode", kind: "function", name: "SharedTool", signature: "function SharedTool()", startLine: 1, endLine: 10 })
        yield* repo.putNode({ id: "node-web", fileID: "file-web", kind: "function", name: "SharedTool", signature: "function SharedTool()", startLine: 1, endLine: 10 })
        yield* repo.putNode({ id: "node-desktop", fileID: "file-desktop", kind: "function", name: "SharedTool", signature: "function SharedTool()", startLine: 1, endLine: 10 })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.query({ query: "SharedTool" })

        expect(result.status).toBe("success")
        expect(result.symbols.length).toBe(1)
        expect(result.symbols[0]!.id).toBe("node-opencode")
        expect(result.ambiguity).toEqual({ total: 3, kept: 1 })
        const diag = result.diagnostics?.find((d) => d.kind === "ambiguous-symbol")
        expect(diag).toBeDefined()
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("explain with focusDirs returns the focused symbol", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-opencode", path: "packages/opencode/src/explainer.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "file-core", path: "packages/core/src/explainer.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })

        yield* repo.putNode({ id: "node-opencode", fileID: "file-opencode", kind: "class", name: "ExplainTool", signature: "class ExplainTool", startLine: 1, endLine: 10 })
        yield* repo.putNode({ id: "node-core", fileID: "file-core", kind: "class", name: "ExplainTool", signature: "class ExplainTool", startLine: 1, endLine: 10 })

        const ri = yield* RepositoryIntelligence.Service
        const slc = yield* ri.explain({
          symbol: "ExplainTool",
          workspace: { worktree: "/fake", focusDirs: ["packages/core"] },
        })

        expect(slc.status).toBe("success")
        expect(slc.importantSymbols.length).toBe(1)
        expect(slc.importantSymbols[0]!.id).toBe("node-core")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("trace with focusDirs returns the focused symbol", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-opencode", path: "packages/opencode/src/tracer.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "file-core", path: "packages/core/src/tracer.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })

        yield* repo.putNode({ id: "node-opencode", fileID: "file-opencode", kind: "function", name: "TraceTarget", signature: "function TraceTarget()", startLine: 1, endLine: 10 })
        yield* repo.putNode({ id: "node-core", fileID: "file-core", kind: "function", name: "TraceTarget", signature: "function TraceTarget()", startLine: 1, endLine: 10 })

        const ri = yield* RepositoryIntelligence.Service
        const slc = yield* ri.trace({
          symbol: "TraceTarget",
          workspace: { worktree: "/fake", focusDirs: ["packages/opencode"] },
        })

        expect(slc.status).toBe("success")
        expect(slc.importantSymbols.length).toBe(1)
        expect(slc.importantSymbols[0]!.id).toBe("node-opencode")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

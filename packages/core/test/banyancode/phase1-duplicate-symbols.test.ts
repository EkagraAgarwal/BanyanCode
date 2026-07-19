import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import {
  RepositoryIntelligence,
  defaultLayer as repositoryIntelligenceDefaultLayer,
} from "../../src/banyancode/repository-intelligence"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(
  repositoryIntelligenceDefaultLayer,
  CodegraphRepo.defaultLayer,
)

// Plan Phase 0 fixture: the same symbol name appears in product packages
// (`packages/opencode`, `packages/core`, `packages/tui`) AND in UI packages
// (`packages/web`, `packages/app`, `packages/desktop`, `packages/storybook`).
// Resolution must select deterministically and surface diagnostics for the
// caller when scopes do not constrain the answer.
const seedDuplicateSymbolFixture = () =>
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service

    yield* repo.putFile({ id: "f-opencode-tool", path: "packages/opencode/src/tools/task.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
    yield* repo.putFile({ id: "f-core-tool", path: "packages/core/src/tools/task.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })
    yield* repo.putFile({ id: "f-tui-tool", path: "packages/tui/src/components/task.tsx", contentHash: "h3", language: "tsx", indexedAt: 3 })
    yield* repo.putFile({ id: "f-web-tool", path: "packages/web/src/widgets/task.tsx", contentHash: "h4", language: "tsx", indexedAt: 4 })
    yield* repo.putFile({ id: "f-app-tool", path: "packages/app/src/views/task.tsx", contentHash: "h5", language: "tsx", indexedAt: 5 })
    yield* repo.putFile({ id: "f-desktop-tool", path: "packages/desktop/src/views/task.tsx", contentHash: "h6", language: "tsx", indexedAt: 6 })

    yield* repo.putNode({ id: "n-opencode-task", fileID: "f-opencode-tool", kind: "function", name: "TaskTool", signature: "function TaskTool()", startLine: 1, endLine: 10 })
    yield* repo.putNode({ id: "n-core-task", fileID: "f-core-tool", kind: "function", name: "TaskTool", signature: "function TaskTool()", startLine: 1, endLine: 10 })
    yield* repo.putNode({ id: "n-tui-task", fileID: "f-tui-tool", kind: "function", name: "TaskTool", signature: "function TaskTool()", startLine: 1, endLine: 10 })
    yield* repo.putNode({ id: "n-web-task", fileID: "f-web-tool", kind: "function", name: "TaskTool", signature: "function TaskTool()", startLine: 1, endLine: 10 })
    yield* repo.putNode({ id: "n-app-task", fileID: "f-app-tool", kind: "function", name: "TaskTool", signature: "function TaskTool()", startLine: 1, endLine: 10 })
    yield* repo.putNode({ id: "n-desktop-task", fileID: "f-desktop-tool", kind: "function", name: "TaskTool", signature: "function TaskTool()", startLine: 1, endLine: 10 })
  })

describe("Phase 0: duplicate symbol fixture", () => {
  test("unscoped query returns every product-package candidate and an ambiguity diagnostic", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedDuplicateSymbolFixture()
        const ri = yield* RepositoryIntelligence.Service

        const result = yield* ri.query({ query: "TaskTool" })
        const ids = result.symbols.map((n) => n.id).sort()

        expect(result.status).toBe("success")
        expect(ids).toContain("n-opencode-task")
        expect(ids).toContain("n-core-task")
        expect(ids).toContain("n-tui-task")
        expect(ids).not.toContain("n-web-task")
        expect(ids).not.toContain("n-app-task")
        expect(ids).not.toContain("n-desktop-task")
        expect(result.ambiguity).toEqual({ total: 6, kept: 3 })
        const diag = result.diagnostics?.find((d) => d.kind === "ambiguous-symbol")
        expect(diag).toBeDefined()
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("focusDirs = [packages/opencode] returns exactly the opencode TaskTool", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedDuplicateSymbolFixture()
        const ri = yield* RepositoryIntelligence.Service

        const result = yield* ri.query({
          query: "TaskTool",
          workspace: { worktree: "/fake", focusDirs: ["packages/opencode"] },
        })

        expect(result.status).toBe("success")
        expect(result.symbols.length).toBe(1)
        expect(result.symbols[0]!.id).toBe("n-opencode-task")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("focusDirs = [packages/web] returns exactly the web TaskTool", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedDuplicateSymbolFixture()
        const ri = yield* RepositoryIntelligence.Service

        const result = yield* ri.query({
          query: "TaskTool",
          workspace: { worktree: "/fake", focusDirs: ["packages/web"] },
        })

        expect(result.status).toBe("success")
        expect(result.symbols.length).toBe(1)
        expect(result.symbols[0]!.id).toBe("n-web-task")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("focusDirs = [packages/opencode, packages/web] returns both scoped candidates and ambiguity metadata", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedDuplicateSymbolFixture()
        const ri = yield* RepositoryIntelligence.Service

        const result = yield* ri.query({
          query: "TaskTool",
          workspace: {
            worktree: "/fake",
            focusDirs: ["packages/opencode", "packages/web"],
          },
        })

        const ids = result.symbols.map((n) => n.id).sort()
        expect(result.status).toBe("success")
        expect(ids).toEqual(["n-opencode-task", "n-web-task"])
        expect(result.ambiguity).toEqual({ total: 6, kept: 2 })
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("focusDirs = [packages/nonexistent] returns empty + outside-focus-dirs diagnostic", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedDuplicateSymbolFixture()
        const ri = yield* RepositoryIntelligence.Service

        const result = yield* ri.query({
          query: "TaskTool",
          workspace: { worktree: "/fake", focusDirs: ["packages/nonexistent"] },
        })

        expect(result.status).toBe("success")
        expect(result.symbols.length).toBe(0)
        expect(result.degraded).toBe(false)
        const focusDiag = result.diagnostics?.find((d) => d.kind === "outside-focus-dirs")
        expect(focusDiag).toBeDefined()
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
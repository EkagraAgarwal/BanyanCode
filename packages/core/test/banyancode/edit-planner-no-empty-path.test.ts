import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { CodegraphAnalyzer, defaultLayer as codegraphAnalyzerDefaultLayer } from "../../src/banyancode/codegraph-analyzer"
import { EditPlanner, defaultLayer as editPlannerDefaultLayer } from "../../src/banyancode/edit-planner"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

async function runTest(seed: Effect.Effect<any, any, any>, testEff: Effect.Effect<any, any, any>): Promise<void> {
  const tmp = await tmpdir()
  const dbPath = path.join(tmp.path, "test.db")
  const dbLayer = Database.layerFromPath(dbPath)
  const testLayer = Layer.mergeAll(
    codegraphRepoDefaultLayer,
    codegraphAnalyzerDefaultLayer,
    editPlannerDefaultLayer,
  )
  const program = Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* DatabaseMigration.apply(db)
    yield* seed
    return yield* testEff
  })
  try {
    await Effect.runPromise(
      program.pipe(
        Effect.provide(testLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ) as Effect.Effect<unknown, never, never>,
    )
  } finally {
    await tmp[Symbol.asyncDispose]()
  }
}

const formatDateNode = {
  id: "f1:n1",
  fileID: "f1",
  kind: "function" as const,
  name: "formatDate",
  signature: "function formatDate(d: Date): string",
  startLine: 1,
  endLine: 10,
  code: "export function formatDate(d: Date): string { return d.toISOString() }",
}

describe("edit-planner planBeforeEdit step emission", () => {
  test("target resolves, filePath omitted → read step path is resolved from filePathMap", async () => {
    const seed = Effect.gen(function* () {
      const repo = yield* CodegraphRepo.Service
      yield* repo.writeFileGraph({
        file: { id: "f1", path: "src/utils/helper.ts", contentHash: "h1", language: "typescript", indexedAt: 1 },
        nodes: [formatDateNode],
        edges: [],
      })
    })
    const testEff = Effect.gen(function* () {
      const planner = yield* EditPlanner.Service
      const plan = yield* planner.planBeforeEdit({
        targetSymbol: "formatDate",
        changeKind: "modify",
        // filePath deliberately omitted
      })
      const readStep = plan.steps.find((s) => s.tool === "read")
      expect(readStep).toBeDefined()
      if (readStep) {
        expect(readStep.args.path).toBeTruthy()
        expect(readStep.args.path).not.toBe("")
      }
    })
    await runTest(seed, testEff)
  })

  test("target resolves, filePath provided → read step path is the provided filePath", async () => {
    const seed = Effect.gen(function* () {
      const repo = yield* CodegraphRepo.Service
      yield* repo.writeFileGraph({
        file: { id: "f1", path: "src/utils/helper.ts", contentHash: "h1", language: "typescript", indexedAt: 1 },
        nodes: [formatDateNode],
        edges: [],
      })
    })
    const testEff = Effect.gen(function* () {
      const planner = yield* EditPlanner.Service
      const plan = yield* planner.planBeforeEdit({
        targetSymbol: "formatDate",
        changeKind: "modify",
        filePath: "src/utils/helper.ts",
      })
      const readStep = plan.steps.find((s) => s.tool === "read")
      expect(readStep).toBeDefined()
      if (readStep) {
        expect(readStep.args.path).toBe("src/utils/helper.ts")
      }
    })
    await runTest(seed, testEff)
  })

  test("target unresolved → no read step emitted (grep + code_find only)", async () => {
    const seed = Effect.gen(function* () {
      const repo = yield* CodegraphRepo.Service
      yield* repo.writeFileGraph({
        file: { id: "f1", path: "src/utils/helper.ts", contentHash: "h1", language: "typescript", indexedAt: 1 },
        nodes: [formatDateNode],
        edges: [],
      })
    })
    const testEff = Effect.gen(function* () {
      const planner = yield* EditPlanner.Service
      const plan = yield* planner.planBeforeEdit({
        targetSymbol: "NonExistentSymbolXYZ",
        changeKind: "modify",
      })
      const readStep = plan.steps.find((s) => s.tool === "read")
      expect(readStep).toBeUndefined()
      expect(plan.steps.some((s) => s.tool === "grep")).toBe(true)
      expect(plan.steps.some((s) => s.tool === "code_find")).toBe(true)
    })
    await runTest(seed, testEff)
  })

  test("changeKind=add with similar symbols → read step uses similar file path", async () => {
    const parseDateNode = {
      id: "f2:n1",
      fileID: "f2",
      kind: "function" as const,
      name: "parseDate",
      signature: "function parseDate(s: string): Date",
      startLine: 1,
      endLine: 10,
      code: "export function parseDate(s: string): Date { return new Date(s) }",
    }
    const seed = Effect.gen(function* () {
      const repo = yield* CodegraphRepo.Service
      yield* repo.writeFileGraph({
        file: { id: "f1", path: "src/utils/helper.ts", contentHash: "h1", language: "typescript", indexedAt: 1 },
        nodes: [formatDateNode],
        edges: [],
      })
      yield* repo.writeFileGraph({
        file: { id: "f2", path: "src/utils/date-helper.ts", contentHash: "h2", language: "typescript", indexedAt: 2 },
        nodes: [parseDateNode],
        edges: [],
      })
    })
    const testEff = Effect.gen(function* () {
      const planner = yield* EditPlanner.Service
      // "Date" is a substring of "formatDate" and "parseDate" — filter is n.name.includes(target)
      const plan = yield* planner.planBeforeEdit({
        targetSymbol: "Date",
        changeKind: "add",
      })
      const codeFindStep = plan.steps.find((s) => s.tool === "code_find")
      expect(codeFindStep).toBeDefined()
      // "formatDate" includes "Date", so it's found as similar
      expect(["formatDate", "parseDate"]).toContain(codeFindStep!.args.target as string)

      const readStep = plan.steps.find((s) => s.tool === "read")
      expect(readStep).toBeDefined()
      expect(readStep!.args.path).toMatch(/helper\.ts|date-helper\.ts/)
    })
    await runTest(seed, testEff)
  })

  test("changeKind=add with no similar symbols → read step absent", async () => {
    const seed = Effect.succeed(undefined) // empty graph
    const testEff = Effect.gen(function* () {
      const planner = yield* EditPlanner.Service
      const plan = yield* planner.planBeforeEdit({
        targetSymbol: "BrandNewSymbol",
        changeKind: "add",
      })
      const codeFindStep = plan.steps.find((s) => s.tool === "code_find")
      expect(codeFindStep).toBeDefined()
      // BrandNewSymbol doesn't match anything seeded, so it falls back to targetSymbol itself
      expect(codeFindStep!.args.target).toBe("BrandNewSymbol")

      const readStep = plan.steps.find((s) => s.tool === "read")
      expect(readStep).toBeUndefined()
    })
    await runTest(seed, testEff)
  })
})

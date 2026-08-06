import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { RepositoryIntelligence, defaultLayer as repositoryIntelligenceDefaultLayer } from "../../src/banyancode/repository-intelligence"

process.env.BANYANCODE_ENABLE = "1"

// Phase 0 regression fixtures: a REAL indexer pass over a tmpdir. Test files
// import a real symbol from `src/`; a `test/mock-utils.test.ts` defines
// mock-helper style functions that merely mention the target name.
const serviceLayer = Layer.mergeAll(
  repositoryIntelligenceDefaultLayer,
  CodegraphIndexer.layer,
).pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(codegraphRepoDefaultLayer),
)

const runIndexed = <A>(
  root: string,
  dbPath: string,
  run: (repo: CodegraphRepo.Interface, ri: RepositoryIntelligence.Interface) => Effect.Effect<A, never, never>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const indexer = yield* CodegraphIndexer.Service
      const repo = yield* CodegraphRepo.Service
      const ri = yield* RepositoryIntelligence.Service
      yield* indexer.index({ root, force: true })
      return yield* run(repo, ri)
    }).pipe(
      Effect.provide(serviceLayer),
      Effect.provide(codegraphRepoDefaultLayer),
      Effect.provide(Database.layerFromPath(dbPath)),
      Effect.scoped,
    ),
  )

const writeFixture = async (
  root: string,
  files: Record<string, string>,
): Promise<void> => {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content)
  }
}

describe("repository_tests against the real indexer", () => {
  test("returns real indexer test files and EXCLUDES mock helpers", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    await writeFixture(tmp.path, {
      "src/parse.ts": `export function parse(input: string): string { return input }\n`,
      "src/format.ts": `export function format(input: string): string { return input.trim() }\n`,
      "test/parse.test.ts": [
        `import { parse } from "../src/parse"`,
        "",
        `test("parses input", () => {`,
        `  expect(parse("x")).toEqual("x")`,
        `})`,
        "",
      ].join("\n"),
      "test/mock-utils.test.ts": [
        `export function makeMockIndexer() {`,
        `  return { parse: () => ({ nodes: [], edges: [] }) }`,
        `}`,
        `export function runWithSeed(seed: string) {`,
        `  return { seed }`,
        `}`,
        `export function getUser() {`,
        `  return { id: 1 }`,
        `}`,
        "",
      ].join("\n"),
    })

    const result = await runIndexed(tmp.path, dbPath, (repo, ri) =>
      Effect.gen(function* () {
        const res = yield* ri.tests({ symbol: "parse" })
        const testFile = yield* repo.getFileByPath(path.join(tmp.path, "test/parse.test.ts"))
        return { res, testFile }
      }),
    )

    expect(result.res.notFound).toBe(false)
    // The real test file must be a hit…
    expect(result.testFile).toBeDefined()
    expect(result.res.tests.some((n) => n.fileID === result.testFile!.id)).toBe(true)
    // …but the mock helpers must NOT be reported as tests.
    const mockNames = ["makeMockIndexer", "runWithSeed", "getUser"]
    for (const name of mockNames) {
      expect(result.res.tests.some((n) => n.name === name)).toBe(false)
    }
  })

  test("per-result derivation + confidence are surfaced; substring matches are low-confidence diagnostics only", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    await writeFixture(tmp.path, {
      "src/parse.ts": `export function parse(input: string): string { return input }\n`,
      "test/parse.test.ts": [
        `import { parse } from "../src/parse"`,
        "",
        `test("parses input", () => {`,
        `  expect(parse("x")).toEqual("x")`,
        `})`,
        "",
      ].join("\n"),
      "test/mock-utils.test.ts": [
        `export function makeMockIndexer() {`,
        `  return { parse: () => ({ nodes: [], edges: [] }) }`,
        `}`,
        "",
      ].join("\n"),
    })

    const result = await runIndexed(tmp.path, dbPath, (_repo, ri) =>
      Effect.gen(function* () {
        const res = yield* ri.tests({ symbol: "parse" })
        return { res }
      }),
    )

    expect(result.res.results.length).toBeGreaterThanOrEqual(2)
    // Every result carries an explicit derivation + 0-100 confidence.
    for (const r of result.res.results) {
      expect(typeof r.derivation).toBe("string")
      expect(typeof r.confidence).toBe("number")
      expect(r.confidence).toBeGreaterThanOrEqual(0)
      expect(r.confidence).toBeLessThanOrEqual(100)
    }
    // The real test file resolves through its import binding.
    const importHit = result.res.results.find((r) => r.node.name === "parse.test.ts")
    expect(importHit).toBeDefined()
    expect(importHit!.derivation).toBe("import-binding")
    expect(importHit!.confidence).toBe(60)
    // A helper whose code merely mentions the target name is an explicit
    // low-confidence diagnostic — never a normal test hit.
    const mockSubstring = result.res.results.find((r) => r.node.name === "makeMockIndexer")
    expect(mockSubstring).toBeDefined()
    expect(mockSubstring!.derivation).toBe("substring-low-confidence")
    expect(mockSubstring!.confidence).toBe(10)
    expect(result.res.tests.some((n) => n.name === "makeMockIndexer")).toBe(false)
    expect(result.res.tests.some((n) => n.name === "parse.test.ts")).toBe(true)
  })

  test("limit is applied to the per-result evidence list", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const specs: string[] = []
    for (let i = 1; i <= 6; i++) {
      specs.push(`export function spec${i}() { return parse("${i}") }`)
    }
    await writeFixture(tmp.path, {
      "src/parse.ts": `export function parse(input: string): string { return input }\n`,
      "test/multi.test.ts": [`import { parse } from "../src/parse"`, ...specs, ""].join("\n"),
    })

    const result = await runIndexed(tmp.path, dbPath, (_repo, ri) =>
      Effect.gen(function* () {
        const res = yield* ri.tests({ symbol: "parse", limit: 2 })
        return { res }
      }),
    )

    expect(result.res.results.length).toBe(2)
    // All evidence-backed derivations — never a substring diagnostic.
    expect(result.res.results.every((r) => r.derivation !== "substring-low-confidence")).toBe(true)
  })

  test("trace and explain surface genuine ambiguity instead of silently anchoring", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    // Two distinct files define a symbol with the SAME exact name — the
    // resolver must surface the ambiguity, not silently pick one.
    await writeFixture(tmp.path, {
      "src/parse.ts": `export function parse(input: string): string { return input }\n`,
      "src/format.ts": `export function parse(input: number): number { return input }\n`,
    })

    const result = await runIndexed(tmp.path, dbPath, (_repo, ri) =>
      Effect.gen(function* () {
        const traceSlice = yield* ri.trace({ symbol: "parse" })
        const explainSlice = yield* ri.explain({ symbol: "parse" })
        return { traceSlice, explainSlice }
      }),
    )

    const traceDiag = result.traceSlice.diagnostics?.find((d) => d.kind === "ambiguous-symbol")
    expect(traceDiag).toBeDefined()
    expect(traceDiag!.message).toMatch(/disambiguate/)
    const explainDiag = result.explainSlice.diagnostics?.find((d) => d.kind === "ambiguous-symbol")
    expect(explainDiag).toBeDefined()
  })

  test("tests on an unresolved symbol reports notFound and no phantom results", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    await writeFixture(tmp.path, {
      "src/parse.ts": `export function parse(input: string): string { return input }\n`,
    })

    const result = await runIndexed(tmp.path, dbPath, (_repo, ri) =>
      Effect.gen(function* () {
        const res = yield* ri.tests({ symbol: "DefinitelyNotIndexed" })
        return { res }
      }),
    )

    expect(result.res.notFound).toBe(true)
    expect(result.res.tests.length).toBe(0)
    expect(result.res.results.length).toBe(0)
  })
})

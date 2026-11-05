/**
 * Codegraph workstream tests — real temp repos, real SQLite, no mocks.
 *
 * Ported from the highest-value v1 suites: indexing a small TS+Python tree,
 * skip buckets, FTS search, symbol resolution, callers, incremental update
 * after a file change, build-service progress, and the system-prompt policy.
 */
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Queue, Scope } from "effect"
import { Storage } from "../../src/storage/index.js"
import { make as makeRepo } from "../../src/codegraph/codegraph-repo.js"
import { make as makeIndexer } from "../../src/codegraph/codegraph-indexer.js"
import { make as makeBuildService } from "../../src/codegraph/codegraph-build-service.js"
import { make as makeReadiness } from "../../src/codegraph/codegraph-readiness.js"
import { make as makeAnalyzer } from "../../src/codegraph/codegraph-analyzer.js"
import { makeService as makeSearch } from "../../src/codegraph/search/search.js"
import { make as makeStructural } from "../../src/codegraph/structural-queries/structural-queries.js"
import { resolveGraphTargetPure } from "../../src/codegraph/symbol-resolver.js"
import {
  graphLineFor,
  policySystemParts,
  renderPolicy,
  renderPolicyParts,
  POLICY_TEXT,
} from "../../src/codegraph/system-policy.js"
import { tool as codegraphTool } from "../../src/codegraph/tools/codegraph.js"
import { TOOL_IDS } from "../../src/codegraph/index.js"
import { make as makeCodegraphPort } from "../../src/integration/codegraph-port.js"
import { computeCodeFind, renderCodeFind } from "../../src/intel/code-find.js"

const withTemp = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-codegraph-"))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const write = async (root: string, path: string, content: string) => {
  const absolute = join(root, path)
  await mkdir(join(absolute, ".."), { recursive: true })
  await writeFile(absolute, content, "utf8")
  return absolute
}

const seedRepo = async (root: string) => {
  await write(
    root,
    "src/math.ts",
    [
      "export function add(a: number, b: number) {",
      "  return a + b",
      "}",
      "",
      "export function double(a: number) {",
      "  return add(a, a)",
      "}",
    ].join("\n"),
  )
  await write(
    root,
    "src/main.ts",
    ["import { double } from \"./math\"", "", "export function run() {", "  return double(2)", "}"].join("\n"),
  )
  await write(
    root,
    "py/app.py",
    ["def greet(name):", "    return 'hello ' + name", "", "class Greeter:", "    def run(self):", "        return greet('world')"].join(
      "\n",
    ),
  )
  await write(root, ".banyancode/ignore", "ignored.ts\n")
  await write(root, "src/ignored.ts", "export function invisible() { return 1 }\n")
  await write(root, "node_modules/pkg/index.ts", "export function vendored() { return 1 }\n")
}

const withServices = async (
  root: string,
  fn: (services: {
    storage: Storage.Interface
    repo: ReturnType<typeof makeRepo>
    indexer: Effect.Success<ReturnType<typeof makeIndexer>>
    buildService: Effect.Success<ReturnType<typeof makeBuildService>>
    readiness: Effect.Success<ReturnType<typeof makeReadiness>>
    autoUpdate: { state: () => Effect.Effect<{ status: "idle"; pending: number }> }
  }) => Effect.Effect<void, unknown, Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const storage = yield* Storage.open({ projectRoot: root, env: {} })
        const repo = makeRepo(storage)
        const indexer = yield* makeIndexer(repo, storage)
        const buildService = yield* makeBuildService({ indexer, repo, dbPath: () => storage.path })
        const readiness = yield* makeReadiness({ buildService, repo })
        const autoUpdate = { state: () => Effect.succeed({ status: "idle" as const, pending: 0 }) }
        yield* fn({ storage, repo, indexer, buildService, readiness, autoUpdate })
      }),
    ),
  )

describe("codegraph indexer", () => {
  test("indexes a TS + Python tree and reports explicit skip buckets", async () => {
    await withTemp(async (directory) => {
      await seedRepo(directory)
      await write(directory, "src/huge.ts", `export const blob = "${"x".repeat(1_100_000)}"\n`)
      await withServices(directory, ({ repo, indexer, storage }) =>
        Effect.gen(function* () {
          const result = yield* indexer.index({ root: directory, force: true })

          expect(result.indexed).toBeGreaterThanOrEqual(3)
          // node_modules is gitignored by the default patterns.
          expect(result.skippedByReason.gitignored).toBeGreaterThanOrEqual(1)
          // `.banyancode/ignore` names ignored.ts.
          expect(result.skippedByReason.banyanignored).toBeGreaterThanOrEqual(1)
          // The 1.1 MB file exceeds the 1 MB walk budget.
          expect(result.skippedByReason.tooLarge).toBeGreaterThanOrEqual(1)
          // Buckets are an explicit sum, never a residual.
          const sum = Object.values(result.skippedByReason).reduce((a, b) => a + b, 0)
          expect(result.skipped).toBe(sum)

          const files = yield* repo.listAllFiles()
          const paths = files.map((file) => file.path.replace(/\\/g, "/"))
          expect(paths.some((p) => p.endsWith("src/math.ts"))).toBe(true)
          expect(paths.some((p) => p.endsWith("src/main.ts"))).toBe(true)
          expect(paths.some((p) => p.endsWith("py/app.py"))).toBe(true)
          expect(paths.some((p) => p.endsWith("ignored.ts"))).toBe(false)

          expect(storage.path.endsWith(".db")).toBe(true)
          // `index()` writes rows only; `bumpVersion` (called by the build
          // service) is what stamps the meta row.
          const bumped = yield* repo.bumpVersion({ eligibleFiles: result.eligibleFiles, indexedRoot: directory })
          expect(bumped.totalFiles).toBe(files.length)
          const meta = yield* repo.getMeta()
          expect(meta?.totalFiles).toBe(files.length)
          expect(meta?.graphVersion).toBe(1)
          expect(meta?.indexedRoot).toBe(directory)
        }),
      )
    })
  })

  test("FTS search finds symbols by partial identifier and ranks name hits", async () => {
    await withTemp(async (directory) => {
      await seedRepo(directory)
      await withServices(directory, ({ repo, indexer }) =>
        Effect.gen(function* () {
          yield* indexer.index({ root: directory, force: true })
          const hits = yield* repo.ftsSearchNodes({ query: "doubl", limit: 10 })
          expect(hits.map((h) => h.name)).toContain("double")

          const exact = yield* repo.ftsSearchNodes({ query: "add", limit: 10 })
          expect(exact[0]?.name).toBe("add")

          const miss = yield* repo.ftsSearchNodes({ query: "zzzznotpresent", limit: 10 })
          expect(miss).toHaveLength(0)
        }),
      )
    })
  })

  test("resolves definitions and callers, and renders code_find output", async () => {
    await withTemp(async (directory) => {
      await seedRepo(directory)
      await withServices(directory, ({ repo, indexer }) =>
        Effect.gen(function* () {
          yield* indexer.index({ root: directory, force: true })
          const analyzer = makeAnalyzer(repo)

          const resolved = yield* resolveGraphTargetPure(repo, { target: "double" })
          expect(resolved._tag).toBe("Ok")
          if (resolved._tag === "Ok") expect(resolved.value.node.name).toBe("double")

          const callers = yield* analyzer.callers({ function: "add" }).pipe(Effect.orElseSucceed(() => []))
          expect(callers.map((c) => c.name)).toContain("double")

          const graph = { search: makeSearch(repo), structural: makeStructural(repo) }
          const output = yield* computeCodeFind(
            makeCodegraphPort(repo),
            { intent: "definition", target: "double", includeKeywordFallback: true },
            graph,
          )
          const content = renderCodeFind(output)
          expect(content).toContain("matches=1")
          expect(content).toContain("function double")
          expect(content).toContain("math.ts")
          expect(output.matches).toHaveLength(1)
        }),
      )
    })
  })

  test("namespaced calls resolve through the module and generic declarations are indexed", async () => {
    await withTemp(async (directory) => {
      await write(
        directory,
        "src/util/wildcard.ts",
        [
          'export * as Wildcard from "./wildcard"',
          "export function match(input: string, pattern: string) {",
          "  return input === pattern",
          "}",
        ].join("\n"),
      )
      await write(
        directory,
        "src/consumer.ts",
        [
          'import { Wildcard } from "./util/wildcard"',
          "export function check() {",
          '  return Wildcard.match("a", "*")',
          "}",
        ].join("\n"),
      )
      await write(
        directory,
        "src/config.ts",
        [
          'export * as Config from "./config"',
          "export function latest<K extends string>(key: K) {",
          "  return key",
          "}",
        ].join("\n"),
      )
      await write(
        directory,
        "src/use-config.ts",
        ['import { Config } from "./config"', "export function pick() {", '  return Config.latest("x")', "}"].join("\n"),
      )
      await write(directory, "src/generic.ts", "export const wrap = <T>(value: T) => value\n")

      await withServices(directory, ({ repo, indexer }) =>
        Effect.gen(function* () {
          yield* indexer.index({ root: directory, force: true })
          const analyzer = makeAnalyzer(repo)

          const wildcard = yield* resolveGraphTargetPure(repo, { target: "Wildcard.match" })
          expect(wildcard._tag).toBe("Ok")
          if (wildcard._tag === "Ok") {
            expect(wildcard.value.node.name).toBe("match")
            expect(wildcard.value.derivation).toBe("qualified-split")
          }
          const checkers = yield* analyzer
            .callers({ function: "Wildcard.match" })
            .pipe(Effect.orElseSucceed(() => []))
          expect(checkers.map((node) => node.name)).toContain("check")

          const latest = yield* resolveGraphTargetPure(repo, { target: "Config.latest" })
          expect(latest._tag).toBe("Ok")
          if (latest._tag === "Ok") expect(latest.value.node.name).toBe("latest")
          const pickers = yield* analyzer
            .callers({ function: "Config.latest" })
            .pipe(Effect.orElseSucceed(() => []))
          expect(pickers.map((node) => node.name)).toContain("pick")

          expect(yield* repo.queryNodes({ function: "wrap" })).toHaveLength(1)
        }),
      )
    })
  })

  test("a namespace import without a declaration node resolves through the module filename", async () => {
    await withTemp(async (directory) => {
      await write(
        directory,
        "src/util/flock.ts",
        [
          "export function withLock(key: string, run: () => number) {",
          "  return run()",
          "}",
        ].join("\n"),
      )
      await write(
        directory,
        "src/use-flock.ts",
        [
          'import * as Flock from "./util/flock"',
          "export function locked() {",
          '  return Flock.withLock("k", () => 1)',
          "}",
        ].join("\n"),
      )

      await withServices(directory, ({ repo, indexer }) =>
        Effect.gen(function* () {
          yield* indexer.index({ root: directory, force: true })
          const analyzer = makeAnalyzer(repo)
          const resolved = yield* resolveGraphTargetPure(repo, { target: "Flock.withLock" })
          expect(resolved._tag).toBe("Ok")
          if (resolved._tag === "Ok") expect(resolved.value.node.name).toBe("withLock")
          const callers = yield* analyzer
            .callers({ function: "Flock.withLock" })
            .pipe(Effect.orElseSucceed(() => []))
          expect(callers.map((node) => node.name)).toContain("locked")
        }),
      )
    })
  })

  test("a local variable sharing an imported symbol's name is not a caller", async () => {
    await withTemp(async (directory) => {
      await write(
        directory,
        "src/config.ts",
        ['export * as Config from "./config"', "export function configured() {", "  return 1", "}"].join("\n"),
      )
      await write(
        directory,
        "src/other.ts",
        [
          'import { Config } from "./config"',
          "const configured = 2",
          "export function localUse() {",
          "  return configured + 1",
          "}",
        ].join("\n"),
      )
      await write(
        directory,
        "src/instance.ts",
        ['import { Config } from "./config"', "export function boot() {", "  return Config.configured()", "}"].join("\n"),
      )

      await withServices(directory, ({ repo, indexer }) =>
        Effect.gen(function* () {
          yield* indexer.index({ root: directory, force: true })
          const analyzer = makeAnalyzer(repo)
          const callers = yield* analyzer
            .callers({ function: "Config.configured" })
            .pipe(Effect.orElseSucceed(() => []))
          expect(callers.map((node) => node.name)).toEqual(["boot"])
        }),
      )
    })
  })

  test("incremental update replaces a changed file's nodes and edges", async () => {
    await withTemp(async (directory) => {
      await seedRepo(directory)
      await withServices(directory, ({ repo, indexer }) =>
        Effect.gen(function* () {
          yield* indexer.index({ root: directory, force: true })
          const before = yield* repo.countNodes()

          yield* Effect.promise(() =>
            write(
              directory,
              "src/math.ts",
              [
                "export function add(a: number, b: number) {",
                "  return a + b",
                "}",
                "",
                "export function triple(a: number) {",
                "  return add(a, add(a, a))",
                "}",
              ].join("\n"),
            ),
          )
          const changed = join(directory, "src/math.ts")
          const result = yield* indexer.applyChanges({ root: directory, addedOrChanged: [changed], removed: [] })
          expect(result.indexed).toBe(1)

          const after = yield* repo.countNodes()
          expect(after).toBe(before)

          const hits = yield* repo.queryNodes({ function: "triple" })
          expect(hits).toHaveLength(1)
          expect(hits[0]?.code).toContain("add(a, add(a, a))")
          expect(yield* repo.queryNodes({ function: "double" })).toHaveLength(0)

          // A second pass over the same timestamp-free content is a cache hit.
          const cached = yield* indexer.applyChanges({ root: directory, addedOrChanged: [changed], removed: [] })
          expect(cached.indexed).toBe(0)
        }),
      )
    })
  })
})

describe("codegraph parsing backends", () => {
  test("vendored TypeScript grammar reports real syntax errors and still indexes the file", async () => {
    await withTemp(async (directory) => {
      await write(directory, "src/bad.ts", "export function broken( {\n")
      await withServices(directory, ({ repo, indexer }) =>
        Effect.gen(function* () {
          const result = yield* indexer.index({ root: directory, force: true })
          expect(result.skippedByReason.parseFailure).toBe(1)
          expect(result.parseErrors[0]?.cause).toContain("tree-sitter syntax error")
          const errors = yield* repo.listParseErrors()
          expect(errors.map((e) => e.path)).toContain("src/bad.ts")
          // The file still lands in the graph via the regex fallback.
          const files = yield* repo.listAllFiles()
          expect(files.some((f) => f.path.endsWith("bad.ts"))).toBe(true)
        }),
      )
    })
  })

  test("every vendored grammar parses without degrading to the regex parser", async () => {
    await withTemp(async (directory) => {
      // Python used to be the missing-grammar fixture; all 16 grammars are
      // vendored now, so the tree-sitter backend must parse it cleanly.
      await write(directory, "py/app.py", "def greet(name):\n    return name\n")
      await withServices(directory, ({ repo, indexer }) =>
        Effect.gen(function* () {
          const result = yield* indexer.index({ root: directory, force: true })
          expect(result.indexed).toBe(1)
          expect(result.skippedByReason.parseFailure).toBe(0)
          expect(result.parseErrors).toEqual([])
          const nodes = yield* repo.queryNodes({ function: "greet", kind: "function" })
          expect(nodes).toHaveLength(1)
        }),
      )
    })
  })
})

describe("codegraph build service", () => {
  test("emits progress states on the single events queue and completes", async () => {
    await withTemp(async (directory) => {
      await seedRepo(directory)
      await withServices(directory, ({ buildService }) =>
        Effect.gen(function* () {
          const states: string[] = []
          const drain = yield* Effect.forkScoped(
            Queue.take(buildService.events()).pipe(
              Effect.tap((state) => Effect.sync(() => states.push(state.status))),
              Effect.forever,
            ),
          )
          yield* buildService.start({ root: directory, force: true })
          // start() forks the worker, so poll the same way the tools do.
          let final = yield* buildService.status()
          for (let i = 0; i < 200 && final.status === "running"; i++) {
            yield* Effect.sleep("25 millis")
            final = yield* buildService.status()
          }
          // The terminal queue event is emitted right after the Ref write, so
          // give the bridge a beat before asserting on what it saw.
          for (let i = 0; i < 40 && !states.includes("completed"); i++) {
            yield* Effect.sleep("25 millis")
          }
          yield* Fiber.interrupt(drain).pipe(Effect.ignore)
          expect(final.status).toBe("completed")
          expect(final.result?.indexed).toBeGreaterThanOrEqual(3)
          expect(states.length).toBeGreaterThanOrEqual(1)
          expect(states[0]).toBe("running")
          expect(states).toContain("completed")
        }),
      )
    })
  })
})

describe("codegraph tools", () => {
  test("codegraph_search merges fuzzy and structural hits", async () => {
    await withTemp(async (directory) => {
      await seedRepo(directory)
      await withServices(directory, ({ repo, indexer }) =>
        Effect.gen(function* () {
          yield* indexer.index({ root: directory, force: true })
          const output = yield* computeCodeFind(
            makeCodegraphPort(repo),
            { intent: "search", target: "double" },
            { search: makeSearch(repo), structural: makeStructural(repo) },
          )
          expect(renderCodeFind(output)).toContain("Search results")
          expect(output.results?.some((r) => r.node.name === "double")).toBe(true)
        }),
      )
    })
  })

  test("codegraph_staleness counts touched files after indexing", async () => {
    await withTemp(async (directory) => {
      await seedRepo(directory)
      await withServices(directory, ({ repo, indexer, storage, buildService, readiness, autoUpdate }) =>
        Effect.gen(function* () {
          yield* indexer.index({ root: directory, force: true })
          expect(yield* repo.countStaleFiles()).toBe(0)

          const tool = codegraphTool({
            repo,
            buildService,
            readiness,
            autoUpdate: autoUpdate as never,
            projectRoot: () => directory,
          })
          const clean = yield* tool.execute({ op: "staleness" }, {} as never)
          expect(clean.content).toContain("staleFiles=0")
          expect(clean.content).toContain("Top stale files: none.")

          // Simulate the watcher seeing a file change after the snapshot: the
          // row's mtime_ms is newer than its indexed_at. Writing through the
          // real storage (no mocks) is exactly what the indexer would store.
          const target = join(directory, "src/math.ts").replace(/\\/g, "/")
          yield* storage.query("UPDATE codegraph_files SET mtime_ms = ? WHERE path LIKE ?", [
            Date.now() + 60_000,
            "%math.ts",
          ])
          expect(yield* repo.countStaleFiles()).toBe(1)

          const stale = yield* tool.execute({ op: "staleness" }, {} as never)
          expect(stale.content).toContain("staleFiles=1")
          expect(stale.content).toContain("math.ts")
          expect(target.length).toBeGreaterThan(0)
        }),
      )
    })
  })
})

describe("codegraph remove", () => {
  test("clearAll wipes graph tables, rebuilds FTS and reports freed bytes", async () => {
    await withTemp(async (directory) => {
      await seedRepo(directory)
      await withServices(directory, ({ repo, indexer }) =>
        Effect.gen(function* () {
          yield* indexer.index({ root: directory, force: true })
          yield* repo.bumpVersion({ eligibleFiles: 3, indexedRoot: directory })
          expect(yield* repo.countFiles()).toBeGreaterThan(0)

          const cleared = yield* repo.clearAll({ dropFile: false })
          expect(cleared.droppedFile).toBe(false)
          expect(cleared.sizeBefore).toBeGreaterThan(0)
          expect(yield* repo.countFiles()).toBe(0)
          expect(yield* repo.countNodes()).toBe(0)
          expect(yield* repo.countEdges()).toBe(0)
          expect(yield* repo.getMeta()).toBeUndefined()
          // The external-content FTS table must be empty, not corrupt.
          expect(yield* repo.ftsSearchNodes({ query: "double", limit: 5 })).toHaveLength(0)

          // A rebuild after the wipe works (no dangling FTS rows).
          yield* indexer.index({ root: directory, force: true })
          expect((yield* repo.ftsSearchNodes({ query: "double", limit: 5 })).length).toBeGreaterThan(0)
        }),
      )
    })
  })
})

describe("codegraph system policy", () => {
  test("renders the v1 policy plus a guide for registered tools only", () => {
    const text = renderPolicy({
      tools: [{ id: "codegraph", description: "Build (or rebuild) the code graph. Extra detail." }],
      graph: { state: "ready", symbols: 42 },
    })
    expect(text).toContain(POLICY_TEXT)
    expect(text).toContain("## BanyanCode tool guide")
    expect(text).toContain("**codegraph** — Build (or rebuild) the code graph.")
    expect(text).toContain("Graph state: ready (42 symbols)")
    // Tools outside the registered list never appear.
    expect(text).not.toContain("**change_check**")
  })

  test("splits the static policy from the live graph line byte-identically", () => {
    const tools = [{ id: "codegraph", description: "Build (or rebuild) the code graph. Extra detail." }]
    const graph = { state: "ready", symbols: 42 } as const
    const parts = renderPolicyParts({ tools, graph })
    expect(parts.dynamic).toBe(graphLineFor(graph))
    expect(parts.stable).not.toContain("Graph state:")
    expect(`${parts.stable}\n\n${parts.dynamic}`).toBe(renderPolicy({ tools, graph }))
    // No graph readout: stable only, and still byte-identical to the legacy renderer.
    expect(renderPolicyParts({ tools })).toEqual({ stable: renderPolicy({ tools }) })
    // No tool guide: the policy alone stays the stable part.
    expect(renderPolicyParts({ graph })).toEqual({ stable: POLICY_TEXT, dynamic: graphLineFor(graph) })
  })

  test("stable prefix on emits the graph line as its own trailing volatile part", () => {
    const tools = [{ id: "codegraph", description: "Build (or rebuild) the code graph. Extra detail." }]
    const graph = { state: "missing" } as const
    const on = policySystemParts({ tools, graph, stablePrefix: true })
    expect(on).toHaveLength(2)
    expect(on[0]!.text).not.toContain("Graph state:")
    expect(on[0]!.metadata).toEqual({ banyancode: { stable: true, source: "codegraph" } })
    expect(on[1]!.text).toBe(graphLineFor(graph))
    expect(on[1]!.metadata).toEqual({ system: { volatility: "dynamic" }, banyancode: { source: "codegraph" } })
    // Setting off keeps the legacy single part, byte-for-byte.
    expect(policySystemParts({ tools, graph, stablePrefix: false })).toEqual([
      { type: "text", text: renderPolicy({ tools, graph }) },
    ])
  })

  test("consecutive turns keep every stable byte when only the graph state flips", () => {
    const tools = [{ id: "codegraph", description: "Build (or rebuild) the code graph. Extra detail." }]
    const first = policySystemParts({ tools, graph: { state: "building" }, stablePrefix: true })
    const second = policySystemParts({ tools, graph: { state: "ready", symbols: 1234 }, stablePrefix: true })
    expect(second[0]).toEqual(first[0])
    expect(second[1]!.text).not.toBe(first[1]!.text)
  })

  test("registers the single codegraph lifecycle tool", () => {
    expect([...TOOL_IDS]).toEqual(["codegraph"])
  })
})

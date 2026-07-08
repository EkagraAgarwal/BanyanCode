import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { CodegraphAnalyzer, defaultLayer as codegraphAnalyzerDefaultLayer } from "../../src/banyancode/codegraph-analyzer"
import { resolveGraphTargetPure } from "../../src/banyancode/symbol-resolver"
import type { ResolutionDerivation } from "../../src/banyancode/symbol-resolver"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

interface FixtureSymbol {
  readonly name: string
  readonly target: string
  readonly expectedDerivation: ResolutionDerivation
}

const FIXTURES: FixtureSymbol[] = [
  { name: "Context.Service tag", target: "MemoryRepo", expectedDerivation: "tag-fallback" },
  { name: "Context.Service bare class", target: "ConfigRepo", expectedDerivation: "tag-fallback" },
  { name: "qualified Namespace.method", target: "BanyanConfigService.load", expectedDerivation: "qualified-split" },
  // withCwd is a plain top-level function with name `withCwd` — the resolver
  // finds it by exact name before falling through to code-substring, which is
  // the correct derivation ordering.
  { name: "plain top-level function", target: "withCwd", expectedDerivation: "name-exact" },
]

const seedEffect = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* DatabaseMigration.apply(db)
  const repo = yield* CodegraphRepo.Service

  yield* repo.writeFileGraph({
    file: { id: "fA", path: "src/memory.ts", contentHash: "h1", language: "typescript", indexedAt: 1 },
    nodes: [
      {
        id: "fA:n1",
        fileID: "fA",
        kind: "class",
        name: "MemoryRepo",
        signature: "class MemoryRepo extends Context.Service<MemoryRepo, Interface>()",
        startLine: 1,
        endLine: 20,
        code: 'export class MemoryRepo extends Context.Service<MemoryRepo, Interface>()("@banyancode/MemoryRepo") { put() {} }',
      },
    ],
    edges: [],
  })
  yield* repo.writeFileGraph({
    file: { id: "fB", path: "src/config.ts", contentHash: "h2", language: "typescript", indexedAt: 2 },
    nodes: [
      {
        id: "fB:n1",
        fileID: "fB",
        kind: "class",
        name: "ConfigRepo",
        signature: "class ConfigRepo extends Context.Service<ConfigRepo, Interface>()",
        startLine: 1,
        endLine: 30,
        code: 'export class ConfigRepo extends Context.Service<ConfigRepo, Interface>()("@banyancode/ConfigRepo") { load() {} }',
      },
    ],
    edges: [],
  })
  yield* repo.writeFileGraph({
    file: { id: "fC", path: "src/banyan-config-service.ts", contentHash: "h3", language: "typescript", indexedAt: 3 },
    nodes: [
      {
        id: "fC:n1",
        fileID: "fC",
        kind: "class",
        name: "BanyanConfigService",
        signature: "class BanyanConfigService extends Context.Service<BanyanConfigService, Interface>()",
        startLine: 1,
        endLine: 40,
        code: 'export class BanyanConfigService extends Context.Service<BanyanConfigService, Interface>()() {}',
      },
      {
        id: "fC:n2",
        fileID: "fC",
        kind: "method",
        name: "load",
        signature: "load(): Effect<BanyanConfig>",
        startLine: 5,
        endLine: 15,
        code: "load(): BanyanConfig { return {} as BanyanConfig }",
      },
    ],
    edges: [],
  })
  yield* repo.writeFileGraph({
    file: { id: "fD", path: "src/caller.ts", contentHash: "h4", language: "typescript", indexedAt: 4 },
    nodes: [
      {
        id: "fD:n1",
        fileID: "fD",
        kind: "function",
        name: "boot",
        signature: "function boot()",
        startLine: 1,
        endLine: 10,
        code: "function boot() { BanyanConfigService.load() }",
      },
      {
        id: "fD:n2",
        fileID: "fD",
        kind: "function",
        name: "withCwd",
        signature: "function withCwd<T>(cwd: string, fn: () => T): T",
        startLine: 11,
        endLine: 20,
        code: "function withCwd<T>(cwd: string, fn: () => T): T { return fn() }",
      },
      {
        id: "fD:n3",
        fileID: "fD",
        kind: "function",
        name: "doStuff",
        signature: "function doStuff()",
        startLine: 21,
        endLine: 30,
        code: "function doStuff() { withCwd('x', () => 1) }",
      },
    ],
    edges: [
      { id: "e1", fromNodeID: "fD:n1", toNodeID: "fC:n2", kind: "calls" },
      { id: "e2", fromNodeID: "fD:n3", toNodeID: "fD:n2", kind: "calls" },
    ],
  })
})

const withTmpDb = async <A, E, R>(
  body: (
    dbLayer: ReturnType<typeof Database.layerFromPath>,
  ) => Effect.Effect<A, E, R>,
  extraLayer?: Layer.Layer<any, never, never>,
): Promise<A> => {
  const tmp = await tmpdir()
  const dbPath = path.join(tmp.path, "test.db")
  const dbLayer = Database.layerFromPath(dbPath)
  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* seedEffect
      return yield* body(dbLayer)
    }),
  )
  const provided = extraLayer
    ? program.pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(dbLayer), Effect.provide(extraLayer))
    : program.pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(dbLayer))
  try {
    return await Effect.runPromise(provided as Effect.Effect<A, E, never>)
  } finally {
    await tmp[Symbol.asyncDispose]()
  }
}

describe("shared symbol resolver covers real BanyanCode patterns", () => {
  test.each(FIXTURES)("$name → $expectedDerivation", async (fx: FixtureSymbol) => {
    const result = await withTmpDb((dbLayer) =>
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        return yield* resolveGraphTargetPure(repo as never, { target: fx.target })
      }),
    )
    const ok = result as Extract<typeof result, { _tag: "Ok" }>
    expect(ok._tag).toBe("Ok")
    expect(ok.value.derivation).toBe(fx.expectedDerivation)
    expect(ok.value.candidates.length).toBeGreaterThan(0)
  })
})

describe("analyzer uses the shared resolver when only function is given", () => {
  test("Context.Service tag → callers resolves without SymbolNotFoundError", async () => {
    const result = await withTmpDb((dbLayer) =>
      Effect.gen(function* () {
        const analyzer = yield* CodegraphAnalyzer.Service
        return yield* analyzer.callers({ function: "MemoryRepo" })
      }).pipe(Effect.provide(codegraphAnalyzerDefaultLayer)),
    )
    expect(Array.isArray(result)).toBe(true)
  })

  test("qualified name → impact resolves without SymbolNotFoundError", async () => {
    const result = await withTmpDb((dbLayer) =>
      Effect.gen(function* () {
        const analyzer = yield* CodegraphAnalyzer.Service
        return yield* analyzer.impact({ function: "BanyanConfigService.load" })
      }).pipe(Effect.provide(codegraphAnalyzerDefaultLayer)),
    )
    expect(Array.isArray(result.dependents)).toBe(true)
    expect(Array.isArray(result.transitive)).toBe(true)
  })
})

describe("code-substring short-name bypass", () => {
  // Seed a node whose source code contains the literal substring `effect.gen`
  // and which would otherwise win on KIND_RANK (class sorts before function).
  // Without the short-name bypass, searching for "Effect.gen" or "gen" would
  // return this node as a code-substring match even though neither "effect.gen"
  // nor "gen" is its name.
  const seedConfigTagEffectGen = Effect.gen(function* () {
    yield* seedEffect
    const repo = yield* CodegraphRepo.Service
    yield* repo.writeFileGraph({
      file: { id: "fE", path: "src/config-tag.ts", contentHash: "h5", language: "typescript", indexedAt: 5 },
      nodes: [
        {
          id: "fE:n1",
          fileID: "fE",
          kind: "class",
          name: "ConfigTag",
          signature: "class ConfigTag extends Context.Tag",
          startLine: 1,
          endLine: 20,
          code: 'export class ConfigTag extends Context.Tag("ConfigTag")<ConfigTag, Value>() { static build() { return Effect.gen(function*() { return yield* someEffect }) } }',
        },
      ],
      edges: [],
    })
  })

  test("Effect.gen → target-not-resolved (bypass code-substring for short bareword)", async () => {
    const result = await withTmpDb((dbLayer) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* seedConfigTagEffectGen
          const repo = yield* CodegraphRepo.Service
          return yield* resolveGraphTargetPure(repo as never, { target: "Effect.gen" })
        }),
      ),
    )
    expect(result._tag).toBe("Miss")
    // `code-substring` must be in `tried` because the resolver advanced past
    // tag-fallback and name-exact, but the strategy returned empty so it falls
    // through to name-like.
    if (result._tag === "Miss") {
      expect(result.value.tried).toContain("code-substring")
    }
  })

  test("gen → target-not-resolved (3-char bareword is also bypassed)", async () => {
    const result = await withTmpDb((dbLayer) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* seedConfigTagEffectGen
          const repo = yield* CodegraphRepo.Service
          return yield* resolveGraphTargetPure(repo as never, { target: "gen" })
        }),
      ),
    )
    expect(result._tag).toBe("Miss")
  })

  test("MemoryRepo.update → still resolves via qualified-split when leaf is long enough", async () => {
    // Seed a MemoryRepo with an `update` method so MemoryRepo.update qualifies
    // as a non-short, dotted target (leaf length 6). qualified-split must find
    // the method in the same file as the class.
    const seedMemoryRepoUpdate = Effect.gen(function* () {
      yield* seedEffect
      const repo = yield* CodegraphRepo.Service
      yield* repo.writeFileGraph({
        file: { id: "fA", path: "src/memory.ts", contentHash: "h1", language: "typescript", indexedAt: 1 },
        nodes: [
          {
            id: "fA:n1",
            fileID: "fA",
            kind: "class",
            name: "MemoryRepo",
            signature: "class MemoryRepo extends Context.Service",
            startLine: 1,
            endLine: 20,
            code: "class MemoryRepo {}",
          },
          {
            id: "fA:n2",
            fileID: "fA",
            kind: "method",
            name: "update",
            signature: "update(): Effect<void>",
            startLine: 5,
            endLine: 15,
            code: "update() {}",
          },
        ],
        edges: [],
      })
    })
    const result = await withTmpDb((dbLayer) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* seedMemoryRepoUpdate
          const repo = yield* CodegraphRepo.Service
          return yield* resolveGraphTargetPure(repo as never, { target: "MemoryRepo.update" })
        }),
      ),
    )
    const ok = result as Extract<typeof result, { _tag: "Ok" }>
    expect(ok._tag).toBe("Ok")
    expect(ok.value.node.name).toBe("update")
    expect(ok.value.node.fileID).toBe("fA")
  })
})
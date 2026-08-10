import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "../../src/banyancode/codegraph-repo"
import { resolveGraphTargetPure } from "../../src/banyancode/symbol-resolver"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

// WS1 regression (tool-hardening R1): the resolver's qualified-split and
// code-substring steps used to run `searchNodesLight({ limit: 1000 })` with
// NO name filter, so SQL's `ORDER BY name LIMIT 1000` returned only the
// alphabetically-first 1000 nodes (names <= "D" on a 20k-node graph) and
// `MemoryRepo.update`, `MemoryRepo.put`, `CodegraphBuildService.start` all
// resolved as target-not-resolved. This fixture seeds ~1500 nodes whose
// names sort BEFORE those targets, so the pre-fix window never contained
// the method nodes. The test MUST fail on the pre-fix code and pass after
// the SQL-side name filters (LIKE applies before LIMIT).
const seedLargeGraph = () =>
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service

    // Filler: 1500 nodes whose names sort alphabetically before
    // "update"/"put"/"start". Uppercase class names sort before lowercase
    // filler, so the pre-fix 1000-row window is filled by the two class
    // nodes plus filler-0..filler-997 — every method node falls outside.
    const fillerNodes = Array.from({ length: 1500 }, (_, i) => ({
      id: `filler-${i}`,
      fileID: "file-filler",
      kind: "function" as const,
      name: `aaa-${i}`,
      startLine: i,
      endLine: i,
      code: `function aaa-${i}() {}`,
    }))
    yield* repo.writeFileGraph({
      file: {
        id: "file-filler",
        path: "src/filler.ts",
        contentHash: "h-filler",
        language: "typescript",
        indexedAt: 1,
      },
      nodes: fillerNodes,
      edges: [],
    })

    // MemoryRepo class + member methods in one file. The class carries the
    // Context.Service tag so bare `MemoryRepo` also resolves via tag-fallback.
    yield* repo.writeFileGraph({
      file: {
        id: "file-mem",
        path: "src/banyancode/memory-repo.ts",
        contentHash: "h-mem",
        language: "typescript",
        indexedAt: 2,
      },
      nodes: [
        {
          id: "sym-mem-class",
          fileID: "file-mem",
          kind: "class",
          name: "MemoryRepo",
          signature: "class MemoryRepo extends Context.Service<MemoryRepo, Interface>()",
          startLine: 1,
          endLine: 30,
          code: 'export class MemoryRepo extends Context.Service<MemoryRepo, Interface>()("@banyancode/MemoryRepo") {}',
        },
        {
          id: "sym-mem-update",
          fileID: "file-mem",
          kind: "method",
          name: "update",
          signature: "update(): Effect<void>",
          startLine: 5,
          endLine: 15,
          code: "update() {}",
        },
        {
          id: "sym-mem-put",
          fileID: "file-mem",
          kind: "method",
          name: "put",
          signature: "put(): Effect<void>",
          startLine: 16,
          endLine: 26,
          code: "put() {}",
        },
      ],
      edges: [],
    })

    // CodegraphBuildService class + start method in another file.
    yield* repo.writeFileGraph({
      file: {
        id: "file-build",
        path: "src/banyancode/codegraph-build-service.ts",
        contentHash: "h-build",
        language: "typescript",
        indexedAt: 3,
      },
      nodes: [
        {
          id: "sym-build-class",
          fileID: "file-build",
          kind: "class",
          name: "CodegraphBuildService",
          signature: "class CodegraphBuildService extends Context.Service<CodegraphBuildService, Interface>()",
          startLine: 1,
          endLine: 30,
          code: 'export class CodegraphBuildService extends Context.Service<CodegraphBuildService, Interface>()("@banyancode/CodegraphBuildService") {}',
        },
        {
          id: "sym-build-start",
          fileID: "file-build",
          kind: "method",
          name: "start",
          signature: "start(): Effect<void>",
          startLine: 5,
          endLine: 15,
          code: "start() {}",
        },
      ],
      edges: [],
    })

    // A node whose name contains a distinctive identifier, sorted AFTER the
    // pre-fix window ("z" > "D") — the code-substring step must still resolve
    // it via the name-filtered scan (the identifier is not any node's exact
    // name, so name-exact and qualified-split both miss).
    yield* repo.writeFileGraph({
      file: {
        id: "file-zebra",
        path: "src/zebra.ts",
        contentHash: "h-zebra",
        language: "typescript",
        indexedAt: 4,
      },
      nodes: [
        {
          id: "sym-zebra",
          fileID: "file-zebra",
          kind: "function",
          name: "zebraGrommit",
          signature: "function zebraGrommit()",
          startLine: 1,
          endLine: 10,
          code: "function zebraGrommit() { return grommit }",
        },
      ],
      edges: [],
    })
  })

const testLayer = CodegraphRepo.defaultLayer

describe("qualified resolution on a large graph (WS1 window fix)", () => {
  test("MemoryRepo.update resolves past the 1000-node alphabetical window", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "large.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const tag = yield* CodegraphRepo.Service
        const repo = tag as unknown as CodegraphRepo.Interface
        yield* seedLargeGraph()

        const result = yield* resolveGraphTargetPure(repo, { target: "MemoryRepo.update" })
        expect(result._tag).toBe("Ok")
        if (result._tag === "Ok") {
          expect(result.value.node.name).toBe("update")
          expect(result.value.node.fileID).toBe("file-mem")
          expect(["qualified-split", "fts-bm25"]).toContain(result.value.derivation)
        }
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("MemoryRepo.put resolves past the 1000-node alphabetical window", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "large-put.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const tag = yield* CodegraphRepo.Service
        const repo = tag as unknown as CodegraphRepo.Interface
        yield* seedLargeGraph()

        const result = yield* resolveGraphTargetPure(repo, { target: "MemoryRepo.put" })
        expect(result._tag).toBe("Ok")
        if (result._tag === "Ok") {
          expect(result.value.node.name).toBe("put")
          expect(result.value.node.fileID).toBe("file-mem")
          expect(["qualified-split", "fts-bm25"]).toContain(result.value.derivation)
        }
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("CodegraphBuildService.start resolves past the 1000-node alphabetical window", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "large-build.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const tag = yield* CodegraphRepo.Service
        const repo = tag as unknown as CodegraphRepo.Interface
        yield* seedLargeGraph()

        const result = yield* resolveGraphTargetPure(repo, { target: "CodegraphBuildService.start" })
        expect(result._tag).toBe("Ok")
        if (result._tag === "Ok") {
          expect(result.value.node.name).toBe("start")
          expect(result.value.node.fileID).toBe("file-build")
          expect(["qualified-split", "fts-bm25"]).toContain(result.value.derivation)
        }
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("bare MemoryRepo still resolves (tag-fallback is full-table SQL)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "large-bare.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const tag = yield* CodegraphRepo.Service
        const repo = tag as unknown as CodegraphRepo.Interface
        yield* seedLargeGraph()

        const result = yield* resolveGraphTargetPure(repo, { target: "MemoryRepo" })
        expect(result._tag).toBe("Ok")
        if (result._tag === "Ok") {
          expect(result.value.node.fileID).toBe("file-mem")
        }
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("a distinctive identifier inside a node's code resolves via code-substring", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "large-substring.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const tag = yield* CodegraphRepo.Service
        const repo = tag as unknown as CodegraphRepo.Interface
        yield* seedLargeGraph()

        const result = yield* resolveGraphTargetPure(repo, { target: "grommit" })
        expect(result._tag).toBe("Ok")
        if (result._tag === "Ok") {
          expect(result.value.node.id).toBe("sym-zebra")
          expect(result.value.derivation).toBe("code-substring")
        }
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

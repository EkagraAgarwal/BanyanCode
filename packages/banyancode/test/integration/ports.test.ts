import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Interface as CodegraphRepo } from "../../src/codegraph/codegraph-repo.js"
import { make as makeRepo } from "../../src/codegraph/codegraph-repo.js"
import { make as makeQuery } from "../../src/integration/codegraph-query.js"
import { make as makePort } from "../../src/integration/codegraph-port.js"
import { Storage } from "../../src/storage/index.js"

/**
 * Exercises the two integration adapters against a real SQLite project
 * database (real codegraph rows, no mocks). The boot test only proves the
 * plugin loads; this one proves the adapters project real rows correctly.
 */

const withRepo = <A>(
  fn: (repo: CodegraphRepo, storage: Storage.Interface) => Effect.Effect<A, Storage.StorageError>,
): Effect.Effect<A, Storage.StorageError> =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "banyancode-ports-")))
    try {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* Storage.open({
            projectRoot: directory,
            env: { ...process.env, BANYANCODE_PROJECT_DB_DIR: join(directory, "db") },
          })
          return yield* fn(makeRepo(storage), storage)
        }),
      )
    } finally {
      yield* Effect.promise(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
    }
  })

const seed = (repo: CodegraphRepo, storage: Storage.Interface) =>
  Effect.gen(function* () {
    yield* repo.putFile({
      id: "f1",
      path: "src/a.ts",
      contentHash: "h1",
      language: "typescript",
      indexedAt: 1,
      sizeBytes: 10,
      mtimeMs: 1,
    })
    yield* repo.putFile({
      id: "f2",
      path: "src/b.ts",
      contentHash: "h2",
      language: "typescript",
      indexedAt: 1,
      sizeBytes: 10,
      mtimeMs: 1,
    })
    yield* repo.putFile({
      id: "f3",
      path: "src/c.ts",
      contentHash: "h3",
      language: "typescript",
      indexedAt: 1,
      sizeBytes: 10,
      mtimeMs: 1,
    })
    yield* repo.putNodes([
      {
        id: "n1",
        fileID: "f1",
        kind: "class",
        name: "Helper",
        startLine: 1,
        endLine: 10,
        code: "class Helper {}",
        isEntrypoint: 1,
      },
      { id: "n2", fileID: "f1", kind: "method", name: "run", startLine: 2, endLine: 3 },
      { id: "n3", fileID: "f2", kind: "function", name: "main", startLine: 1, endLine: 5 },
      { id: "n4", fileID: "f3", kind: "function", name: "outer", startLine: 1, endLine: 5 },
    ])
    yield* repo.putEdges([
      { id: "e1", fromNodeID: "n3", toNodeID: "n1", kind: "calls" },
      { id: "e2", fromNodeID: "n1", toNodeID: "n3", kind: "imports" },
      { id: "e3", fromNodeID: "n3", toNodeID: "n1", kind: "references" },
      { id: "e4", fromNodeID: "n4", toNodeID: "n3", kind: "calls" },
    ])
    yield* storage.query(
      `INSERT INTO codegraph_service_tags (id, tag, service_name, file_id, node_id, class_name, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["t1", "TestService", "TestService", "f1", "n1", "Helper", 1],
    )
    yield* repo.rebuildFtsIndex()
    yield* repo.setMeta({
      graphBuiltAt: 1,
      graphVersion: 1,
      graphCoverage: 1,
      totalFiles: 3,
      totalNodes: 4,
      totalEdges: 4,
      schemaVersion: 1,
      indexedRoot: "/workspace",
    })
  })

describe("codegraph port over the real repository", () => {
  test("projects every row shape and fills every optional member", async () => {
    const result = await Effect.runPromise(
      withRepo((repo, storage) =>
        Effect.gen(function* () {
          yield* seed(repo, storage)
          const port = makePort(repo)
          return {
            meta: yield* port.meta(),
            files: yield* port.listFiles(),
            byPath: yield* port.getFileByPath("src/a.ts"),
            byID: yield* port.fileByID("f1"),
            nodes: yield* port.nodesByFile("f1"),
            nodesByIDs: yield* port.nodesByIDs(["n1", "n3"]),
            node: yield* port.nodeByID("n1"),
            out: yield* port.edgesFrom(["n1"]),
            into: yield* port.edgesTo(["n1"]),
            search: yield* port.searchByName({ name: "help", limit: 5 }),
            exact: yield* port.findByExactName!({ name: "Helper" }),
            fullText: yield* port.searchFullText!({ query: "helper", limit: 5 }),
            listed: yield* port.listNodes!({ kind: "function" }),
            tag: yield* port.findByServiceTag!("TestService"),
            serviceFiles: yield* port.fileIDsByServiceName!("TestService"),
            dependents: yield* port.dependentFiles!({ fileIDs: ["f1"] }),
          }
        }),
      ),
    )

    expect(result.meta).toMatchObject({ graphVersion: 1, totalFiles: 3, indexedRoot: "/workspace" })
    expect(result.files).toHaveLength(3)
    expect(result.byPath).toMatchObject({ id: "f1", path: "src/a.ts" })
    expect(result.byID).toMatchObject({ id: "f1" })
    expect(result.nodes.map((node) => node.id).sort()).toEqual(["n1", "n2"])
    expect(result.nodesByIDs.map((node) => node.id).sort()).toEqual(["n1", "n3"])
    expect(result.node).toMatchObject({ id: "n1", kind: "class", name: "Helper" })
    expect(result.out.map((edge) => edge.id)).toEqual(["e2"])
    expect(result.into.map((edge) => edge.id).sort()).toEqual(["e1", "e3"])
    expect(result.search.map((node) => node.name)).toEqual(["Helper"])
    expect(result.exact.map((node) => node.name)).toEqual(["Helper"])
    expect(result.fullText.map((node) => node.name)).toContain("Helper")
    expect(result.listed.map((node) => node.name).sort()).toEqual(["main", "outer"])
    expect(result.tag.map((node) => node.name)).toEqual(["Helper"])
    expect(result.serviceFiles).toEqual(["f1"])
    expect(result.dependents).toContain("f2")
  })
})

describe("codegraph gateway query over the real repository", () => {
  test("rewrites graph-backed operations and renders an augment header", async () => {
    const result = await Effect.runPromise(
      withRepo((repo, storage) =>
        Effect.gen(function* () {
          yield* seed(repo, storage)
          const query = makeQuery(repo)
          return {
            symbol: yield* query.route!({
              operation: { kind: "symbol", query: "Helper" },
              call: { tool: "grep", input: {} },
              sessionID: "s1",
            }),
            callers: yield* query.route!({
              operation: { kind: "relationship", relation: "callers", target: "Helper" },
              call: { tool: "grep", input: {} },
              sessionID: "s1",
            }),
            dependents: yield* query.route!({
              operation: { kind: "relationship", relation: "dependents", target: "Helper" },
              call: { tool: "grep", input: {} },
              sessionID: "s1",
            }),
            architecture: yield* query.route!({
              operation: { kind: "architecture", query: "Helper" },
              call: { tool: "grep", input: {} },
              sessionID: "s1",
            }),
            text: yield* query.route!({
              operation: { kind: "text_search", pattern: "Helper" },
              call: { tool: "grep", input: {} },
              sessionID: "s1",
            }),
            header: yield* query.augmentRead!({ path: "src/a.ts", sessionID: "s1" }),
            missing: yield* query.augmentRead!({ path: "src/nope.ts", sessionID: "s1" }),
          }
        }),
      ),
    )

    expect(result.symbol).toEqual({
      tool: "code_find",
      input: { intent: "definition", target: "Helper", includeKeywordFallback: true },
    })
    expect(result.callers).toMatchObject({ tool: "codegraph_callers", input: { function: "Helper" } })
    expect(result.dependents).toMatchObject({ tool: "codegraph_dependents", input: { function: "Helper" } })
    expect(result.architecture).toEqual({ tool: "repository_explain", input: { symbol: "Helper" } })
    expect(result.text).toBeUndefined()
    expect(result.header).toBe("Symbol: Helper | Imports: 1 | References: 1 | Callers: 1 | Dependents: 1")
    expect(result.missing).toBeUndefined()
  })

  test("does not rewrite onto tools that were not registered", async () => {
    const result = await Effect.runPromise(
      withRepo((repo, storage) =>
        Effect.gen(function* () {
          yield* seed(repo, storage)
          const query = makeQuery(repo, { availableTools: new Set(["code_find"]) })
          return {
            symbol: yield* query.route!({
              operation: { kind: "symbol", query: "Helper" },
              call: { tool: "grep", input: {} },
              sessionID: "s1",
            }),
            callers: yield* query.route!({
              operation: { kind: "relationship", relation: "callers", target: "Helper" },
              call: { tool: "grep", input: {} },
              sessionID: "s1",
            }),
          }
        }),
      ),
    )
    expect(result.symbol).toEqual({
      tool: "code_find",
      input: { intent: "definition", target: "Helper", includeKeywordFallback: true },
    })
    expect(result.callers).toBeUndefined()
  })

  test("fails closed to direct when the graph has no meta row", async () => {
    const result = await Effect.runPromise(
      withRepo((repo) =>
        Effect.gen(function* () {
          const query = makeQuery(repo)
          return yield* query.route!({
            operation: { kind: "symbol", query: "Helper" },
            call: { tool: "grep", input: {} },
            sessionID: "s1",
          })
        }),
      ),
    )
    expect(result).toBeUndefined()
  })
})

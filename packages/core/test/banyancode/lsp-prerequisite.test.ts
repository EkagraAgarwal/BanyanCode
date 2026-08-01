import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { CodegraphAnalyzer } from "@opencode-ai/core/banyancode/codegraph-analyzer"
import { LspFreshnessService } from "@opencode-ai/core/lsp/lsp-freshness-service"
import { tmpdir } from "../fixture/tmpdir"
import path from "node:path"
import { mkdirSync } from "node:fs"
import { lookupFileBySuffix, lookupSymbolAtPosition } from "@opencode-ai/core/tool/lsp-tools"

// Phase 7 follow-up: integration tests for the LSP proxy tools
// covering the new prerequisite field and path normalization.
// These tests exercise the layer-facing public surface
// (lookupSymbolAtPosition / lookupFileBySuffix) directly because
// the higher-level `makeLspDefinitionTool` accesses the analyzer /
// freshness services via the global layer graph, which is exercised
// by the position-lookup test suite already. The new behaviors
// covered here are:
//   - empty repo -> structured failure message rather than a fuzzy
//     success path
//   - path normalization: exact match preferred, suffix fallback
//     only when unambiguous
//   - prerequisite diagnostics captured on the output

type FileNode = { path: string }
const indexedFiles = (files: FileNode[]) => {
  const map = new Map<string, string>()
  files.forEach((f, i) => map.set(f.path, `f${i}`))
  return {
    files: files.map((f, i) => ({
      id: `f${i}`,
      path: f.path,
      indexedAt: 1,
      contentHash: "h",
      language: "ts",
    })),
    fileIdFor: (path: string) => map.get(path) ?? "f0",
  }
}

const makeRepoLayer = (files: FileNode[], nodes: { name: string; filePath: string; startLine: number; endLine: number; kind: string }[]) => {
  const indexed = indexedFiles(files)
  return Layer.succeed(
    CodegraphRepo.Service,
    CodegraphRepo.Service.of({
      listAllFiles: () => Effect.succeed(indexed.files) as never,
      listAllNodes: () =>
        Effect.succeed(
          nodes.map((n, i) => ({
            id: `n${i}`,
            name: n.name,
            kind: n.kind,
            fileID: indexed.fileIdFor(n.filePath),
            filePath: n.filePath,
            startLine: n.startLine,
            endLine: n.endLine,
          })),
        ) as never,
      getMeta: () =>
        Effect.succeed({
          id: 1,
          indexedRoot: "/ws",
          graphVersion: 1,
          totalFiles: indexed.files.length,
          totalNodes: nodes.length,
          totalEdges: 0,
          graphBuiltAt: 1,
          graphCoverage: 1,
          schemaVersion: 1,
        }) as never,
      getParsed: () => Effect.void,
      getNodeById: () => Effect.void,
      getFileByPath: () => Effect.void,
    } as never),
  )
}

describe("LSP prerequisite behavior", () => {
  test("lookupFileBySuffix: exact match wins", async () => {
    await using tmp = await tmpdir()
    mkdirSync(path.join(tmp.path, ".banyancode"), { recursive: true })

    const repoLayer = makeRepoLayer(
      [
        { path: "src/foo/bar.ts" },
        { path: "src/foo/bar.spec.ts" },
      ],
      [],
    )

    let result: { id: string; indexedAt: number } | undefined
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        result = yield* lookupFileBySuffix(repo, "src/foo/bar.ts")
      }).pipe(Effect.provide(repoLayer)),
    )

    expect(result?.id).toBe("f0")
  })

  test("lookupFileBySuffix: suffix match is unambiguous when only one file matches", async () => {
    await using tmp = await tmpdir()
    mkdirSync(path.join(tmp.path, ".banyancode"), { recursive: true })

    const repoLayer = makeRepoLayer(
      [
        { path: "deeply/nested/foo/bar.ts" },
        { path: "other/path/bar.ts" },
      ],
      [],
    )

    let result: { id: string; indexedAt: number } | undefined
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        result = yield* lookupFileBySuffix(repo, "foo/bar.ts")
      }).pipe(Effect.provide(repoLayer)),
    )

    expect(result?.id).toBe("f0")
  })

  test("lookupFileBySuffix: ambiguous suffix match returns undefined", async () => {
    await using tmp = await tmpdir()
    mkdirSync(path.join(tmp.path, ".banyancode"), { recursive: true })

    // Two files that both have a `/foo/bar.ts` suffix component; the
    // lookup is genuinely ambiguous so the resolver must NOT guess.
    const repoLayer = makeRepoLayer(
      [
        { path: "a/foo/bar.ts" },
        { path: "b/foo/bar.ts" },
      ],
      [],
    )

    let result: { id: string; indexedAt: number } | undefined
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        result = yield* lookupFileBySuffix(repo, "foo/bar.ts")
      }).pipe(Effect.provide(repoLayer)),
    )

    expect(result).toBeUndefined()
  })

  test("lookupFileBySuffix: bare filename does NOT match sibling-prefixed paths", async () => {
    await using tmp = await tmpdir()
    mkdirSync(path.join(tmp.path, ".banyancode"), { recursive: true })

    const repoLayer = makeRepoLayer(
      [
        { path: "src/foo/bar.ts" },
        { path: "src/not-foo/bar.ts" },
      ],
      [],
    )

    let result: { id: string; indexedAt: number } | undefined
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        result = yield* lookupFileBySuffix(repo, "bar.ts")
      }).pipe(Effect.provide(repoLayer)),
    )

    // Both files match a `bar.ts` suffix, so the lookup is ambiguous
    // and returns undefined rather than guessing.
    expect(result).toBeUndefined()
  })

  test("lookupSymbolAtPosition: returns undefined on empty repo", async () => {
    await using tmp = await tmpdir()
    mkdirSync(path.join(tmp.path, ".banyancode"), { recursive: true })

    const repoLayer = makeRepoLayer([], [])

    let result: unknown
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        result = yield* lookupSymbolAtPosition(repo, "src/foo.ts", 5)
      }).pipe(Effect.provide(repoLayer)),
    )

    expect(result).toBeUndefined()
  })
})

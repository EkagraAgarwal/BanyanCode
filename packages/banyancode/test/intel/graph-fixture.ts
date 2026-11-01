import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GraphEdge, GraphFile, GraphMeta, GraphNode } from "../../src/intel/types.js"
import { makeFixture, type FixtureGraph } from "./fixture.js"

/**
 * Real temp project + graph rows for the fixture tests. Files exist on disk
 * because preflight reads them for event-bridge / HTTP-route extraction and
 * resolves absolute paths; rows are shaped like the codegraph tables.
 */

export const buildProject = async (options: { stale?: boolean } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "banyancode-intel-"))
  const files: Record<string, string> = {
    "packages/core/src/memory-repo.ts": [
      "export class MemoryRepo {",
      "  update(key: string, value: string) {",
      "    return { key, value }",
      "  }",
      "}",
    ].join("\n"),
    "packages/core/src/session.ts": [
      'import { MemoryRepo } from "./memory-repo"',
      "export const resolve = (repo: MemoryRepo) => repo.update('a', 'b')",
      "export const boot = (repo: MemoryRepo) => resolve(repo)",
    ].join("\n"),
    "packages/core/src/memory-repo.test.ts": [
      'import { expect, test } from "bun:test"',
      'import { MemoryRepo } from "./memory-repo"',
      'test("MemoryRepo.update test", () => {',
      "  expect(new MemoryRepo().update('a', 'b')).toEqual({ key: 'a', value: 'b' })",
      "})",
    ].join("\n"),
    "packages/core/src/effect/rpc-bridge.ts": [
      'import { MemoryRepo } from "../memory-repo"',
      "export const bridgeHook = (repo: MemoryRepo) => repo.update('x', 'y')",
    ].join("\n"),
    "packages/core/src/server/httpapi/groups/global.ts": [
      'import { MemoryRepo } from "../../../../memory-repo"',
      'HttpApiEndpoint.post("update", "/update", { payload: MemoryRepo })',
    ].join("\n"),
    "packages/core/package.json": '{"name":"core","version":"1.0.0"}',
    "docs/memory.md": "# Memory\n\nMemoryRepo.update writes a key.",
  }
  for (const [relative, content] of Object.entries(files)) {
    const full = join(root, relative)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, content, "utf8")
  }

  const now = Date.now()
  const indexedAt = now - 60_000
  const meta: GraphMeta = {
    graphBuiltAt: options.stale ? now - 8 * 24 * 60 * 60 * 1000 : now - 1_000,
    graphVersion: 3,
    graphCoverage: 0.93,
    totalFiles: 7,
    totalNodes: 9,
    totalEdges: 8,
    indexedRoot: root.replace(/\\/g, "/"),
  }
  const file = (id: string, relative: string, language = "typescript"): GraphFile => ({
    id,
    path: join(root, relative),
    contentHash: `hash-${id}`,
    language,
    indexedAt,
    sizeBytes: 128,
    mtimeMs: indexedAt,
  })
  const node = (input: {
    id: string
    fileID: string
    kind: GraphNode["kind"]
    name: string
    startLine: number
    endLine: number
    code?: string
    isEntrypoint?: number
    inDegree?: number
  }): GraphNode => input
  const edge = (id: string, fromNodeID: string, toNodeID: string, kind: GraphEdge["kind"]): GraphEdge => ({
    id,
    fromNodeID,
    toNodeID,
    kind,
  })

  const filesRows: GraphFile[] = [
    file("file-repo", "packages/core/src/memory-repo.ts"),
    file("file-session", "packages/core/src/session.ts"),
    file("file-test", "packages/core/src/memory-repo.test.ts"),
    file("file-bridge", "packages/core/src/effect/rpc-bridge.ts"),
    file("file-routes", "packages/core/src/server/httpapi/groups/global.ts"),
    file("file-pkg", "packages/core/package.json", "json"),
    file("file-docs", "docs/memory.md", "markdown"),
  ]

  const nodes: GraphNode[] = [
    node({ id: "node-repo", fileID: "file-repo", kind: "class", name: "MemoryRepo", startLine: 1, endLine: 5 }),
    node({
      id: "node-update",
      fileID: "file-repo",
      kind: "method",
      name: "update",
      startLine: 2,
      endLine: 4,
      code: "update(key, value)",
      inDegree: 6,
    }),
    node({
      id: "node-resolve",
      fileID: "file-session",
      kind: "function",
      name: "resolve",
      startLine: 2,
      endLine: 2,
      code: "resolve() { update() }",
    }),
    node({ id: "node-boot", fileID: "file-session", kind: "function", name: "boot", startLine: 3, endLine: 3 }),
    node({
      id: "node-test",
      fileID: "file-test",
      kind: "test",
      name: "MemoryRepo.update test",
      startLine: 3,
      endLine: 5,
      code: 'import { MemoryRepo } from "./memory-repo"',
    }),
    node({
      id: "node-bridge",
      fileID: "file-bridge",
      kind: "function",
      name: "bridgeHook",
      startLine: 2,
      endLine: 2,
      code: "bridgeHook(repo) { repo.update() }",
    }),
    node({
      id: "node-route",
      fileID: "file-routes",
      kind: "route",
      name: "updateRoute",
      startLine: 2,
      endLine: 2,
      code: 'HttpApiEndpoint.post("update", "/update")',
      isEntrypoint: 1,
    }),
    node({ id: "node-pkg", fileID: "file-pkg", kind: "variable", name: "version", startLine: 1, endLine: 1 }),
    node({
      id: "node-docs",
      fileID: "file-docs",
      kind: "doc",
      name: "memory docs",
      startLine: 1,
      endLine: 3,
      code: "MemoryRepo.update",
    }),
  ]

  const edges: GraphEdge[] = [
    edge("edge-resolve-update", "node-resolve", "node-update", "calls"),
    edge("edge-boot-resolve", "node-boot", "node-resolve", "calls"),
    edge("edge-test-update", "node-test", "node-update", "references"),
    edge("edge-update-test", "node-update", "node-test", "tested_by"),
    edge("edge-bridge-update", "node-bridge", "node-update", "references"),
    edge("edge-route-update", "node-route", "node-update", "calls"),
    edge("edge-pkg-update", "node-pkg", "node-update", "references"),
    edge("edge-docs-update", "node-docs", "node-update", "references"),
  ]

  const fixture: FixtureGraph = makeFixture({
    files: filesRows,
    nodes,
    edges,
    meta,
    serviceTags: { MemoryRepo: ["node-repo"] },
  })

  return { root, fixture, meta, now }
}

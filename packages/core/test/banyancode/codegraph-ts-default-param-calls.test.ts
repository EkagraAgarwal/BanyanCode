import { test, expect } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Layer } from "effect"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as repoLayer } from "../../src/banyancode/codegraph-repo"
import { resolveGraphTargetPure } from "../../src/banyancode/symbol-resolver"
process.env.BANYANCODE_ENABLE = "1"
const serviceLayer = CodegraphIndexer.layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(repoLayer))
test("cross-file call is derived when the caller has a `{}` default parameter", async () => {
  await using tmp = await tmpdir()
  const d = path.join(tmp.path, "src"); await fs.mkdir(d, { recursive: true })
  await fs.writeFile(path.join(d, "server.ts"), `export async function createMcpServer(opts: number = 1) {\n  return opts\n}\n`)
  await fs.writeFile(path.join(d, "stdio.ts"), `import { createMcpServer, log, type Opts } from "./server"\n\nexport async function serveStdio(opts: Opts = {}): Promise<void> {\n  const { mcp } = await createMcpServer(opts)\n  log(mcp)\n}\n`)
  const rows = await Effect.runPromise(Effect.gen(function* () {
    const idx = yield* CodegraphIndexer.Service
    yield* idx.index({ root: tmp.path, force: true })
    const { db } = yield* Database.Service
    return yield* db.all<any>(sql`SELECT e.kind k, s.name sn, t.name tn FROM codegraph_edges e JOIN codegraph_nodes s ON s.id=e.from_node_id JOIN codegraph_nodes t ON t.id=e.to_node_id`)
  }).pipe(Effect.provide(serviceLayer), Effect.provide(Database.layerFromPath(path.join(tmp.path, "graph.sqlite"))), Effect.scoped))
  expect(rows.some((r: any) => r.k === "calls" && r.tn === "createMcpServer")).toBe(true)
})

test("resolver accepts a node id as the target", async () => {
  await using tmp = await tmpdir()
  await fs.writeFile(path.join(tmp.path, "a.ts"), `export function alpha(opts: number = 1) {\n  return opts\n}\n`)
  const result = await Effect.runPromise(Effect.gen(function* () {
    const idx = yield* CodegraphIndexer.Service
    yield* idx.index({ root: tmp.path, force: true })
    const repo = yield* CodegraphRepo.Service
    const node = (yield* repo.queryNodes({ function: "alpha" }))[0]!
    return { id: node.id, resolved: yield* resolveGraphTargetPure(repo, { target: node.id }) }
  }).pipe(Effect.provide(serviceLayer), Effect.provide(repoLayer), Effect.provide(Database.layerFromPath(path.join(tmp.path, "graph.sqlite"))), Effect.scoped))
  expect(result.resolved._tag).toBe("Ok")
  if (result.resolved._tag === "Ok") expect(result.resolved.value.nodeID).toBe(result.id)
})

test("resolver does not treat a Windows drive-letter path as a node id", async () => {
  let nodeByIDCalls = 0
  const repo = {
    findSymbolsByServiceTag: () => Effect.succeed([]),
    queryNodes: () => Effect.succeed([]),
    searchNodes: () => Effect.succeed([]),
    searchNodesLight: () => Effect.succeed([]),
    nodesByIDs: () => Effect.succeed([]),
    nodeByID: () => {
      nodeByIDCalls++
      return Effect.succeed(undefined)
    },
    fileIDsByServiceName: () => Effect.succeed([]),
    filesByIDs: () => Effect.succeed([]),
  }
  const result = await Effect.runPromise(resolveGraphTargetPure(repo as any, { target: "C:\\Users\\test\\file.ts" }))
  expect(nodeByIDCalls).toBe(0)
  expect(result._tag).toBe("Miss")
})

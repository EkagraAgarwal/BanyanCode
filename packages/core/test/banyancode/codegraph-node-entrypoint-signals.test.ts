import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Banyan } from "@opencode-ai/core/banyancode"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo } from "../../src/banyancode/codegraph-repo"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"

process.env.BANYANCODE_ENABLE = "1"

// Validates the Phase 3 migration:
// 1. is_entrypoint and in_degree columns exist on codegraph_nodes
// 2. The indexer writes is_entrypoint = 1 for a node that matches the
//    ROUTE_REGEX_HINT pattern (e.g. `app.post(...)`) in a routes/* file.
// 3. in_degree is correctly populated for a node that has multiple inbound edges.
describe("Codegraph nodes — entrypoint + in_degree signals (Phase 3 migration)", () => {
  test("is_entrypoint column exists after migration and is populated by the indexer for routes", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    // Fixture: a routes/ folder containing a handler that matches ROUTE_REGEX_HINT.
    const routesDir = path.join(tmp.path, "src", "routes")
    await fs.mkdir(routesDir, { recursive: true })
    await fs.writeFile(
      path.join(routesDir, "users.ts"),
      `import { RouteHandler } from "../handler";
export const getUsers: RouteHandler = async (req, res) => {
  return res.json([{ id: 1 }]);
};
export function postUsers(): void {
  // app.post(...) style registration:
  app.post("/users", () => {});
}`,
    )
    // Plain helper that should NOT be marked as entrypoint.
    await fs.writeFile(
      path.join(tmp.path, "src", "helper.ts"),
      `export function add(a: number, b: number) { return a + b }`,
    )

    const serviceLayer = CodegraphIndexer.layer.pipe(Layer.provide(FSUtil.defaultLayer))

    // Step 1: apply migration + check columns (Database only — no other services)
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const columns = yield* db.all<{ name: string }>(
          sql`SELECT name FROM pragma_table_info('codegraph_nodes') WHERE name IN ('is_entrypoint', 'in_degree')`,
        )
        const names = new Set(columns.map((c) => c.name))
        expect(names.has("is_entrypoint")).toBe(true)
        expect(names.has("in_degree")).toBe(true)
      }).pipe(Effect.provide(dbLayer), Effect.scoped),
    )

    // Step 2: run the indexer and verify the is_entrypoint flag is set.
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const indexer = yield* CodegraphIndexer.Service
        yield* indexer.index({ root: tmp.path })

        const allNodes = yield* repo.listAllNodes()
        const postUsers = allNodes.find((n) => n.name === "postUsers")
        expect(postUsers).toBeDefined()
        expect(postUsers!.isEntrypoint).toBe(1)

        const add = allNodes.find((n) => n.name === "add")
        expect(add).toBeDefined()
        expect(add!.isEntrypoint).toBe(0)
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(CodegraphRepo.defaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("in_degree is correctly populated by recomputeInDegree", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    // Apply migration first.
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
      }).pipe(Effect.provide(dbLayer), Effect.scoped),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        // Seed: one target node + three caller nodes + three edges into target.
        // Direct DB write (no parser) so the test is deterministic.
        const fileID = "file-target"
        yield* repo.putFile({
          id: fileID,
          path: "src/target.ts",
          contentHash: "h",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putNode({
          id: "fn-target",
          fileID,
          kind: "function",
          name: "target",
          startLine: 1,
          endLine: 5,
        })
        yield* repo.putNode({
          id: "fn-caller-a",
          fileID,
          kind: "function",
          name: "caller-a",
          startLine: 1,
          endLine: 5,
        })
        yield* repo.putNode({
          id: "fn-caller-b",
          fileID,
          kind: "function",
          name: "caller-b",
          startLine: 1,
          endLine: 5,
        })
        yield* repo.putNode({
          id: "fn-caller-c",
          fileID,
          kind: "function",
          name: "caller-c",
          startLine: 1,
          endLine: 5,
        })

        yield* repo.putEdge({ id: "e1", fromNodeID: "fn-caller-a", toNodeID: "fn-target", kind: "calls" })
        yield* repo.putEdge({ id: "e2", fromNodeID: "fn-caller-b", toNodeID: "fn-target", kind: "calls" })
        yield* repo.putEdge({ id: "e3", fromNodeID: "fn-caller-c", toNodeID: "fn-target", kind: "calls" })

        // Before recompute, in_degree is 0 (default).
        const before = yield* repo.getNode("fn-target")
        expect(before).toBeDefined()
        expect(before!.inDegree).toBe(0)

        // After recompute, in_degree should equal the count of inbound edges.
        yield* repo.recomputeInDegree()

        const after = yield* repo.getNode("fn-target")
        expect(after).toBeDefined()
        expect(after!.inDegree).toBe(3)

        // Caller nodes have in_degree 0 (no inbound edges).
        const callerA = yield* repo.getNode("fn-caller-a")
        expect(callerA!.inDegree).toBe(0)
      }).pipe(Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

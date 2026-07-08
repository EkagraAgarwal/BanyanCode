import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { CodegraphFilesTable } from "../../src/banyancode/codegraph.sql"
import { CodegraphServiceTagsTable } from "../../src/banyancode/codegraph-service-tags.sql"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(codegraphRepoDefaultLayer)

describe("codegraph_service_tags integrity", () => {
  test("two Context.Service classes in two files both survive indexing", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        // File A: registers @banyancode/MemoryRepo
        yield* repo.writeFileGraph({
          file: {
            id: "file-memory",
            path: "src/memory.ts",
            contentHash: "h1",
            language: "typescript",
            indexedAt: Date.now(),
          },
          nodes: [
            {
              id: "node:MemoryRepo:class",
              fileID: "file-memory",
              kind: "class",
              name: "MemoryRepo",
              signature: "class MemoryRepo extends Context.Service<MemoryRepo, Interface>()",
              startLine: 10,
              endLine: 80,
              code: 'export class MemoryRepo extends Context.Service<MemoryRepo, Interface>()("@banyancode/MemoryRepo") {}',
            },
          ],
          edges: [],
        })

        // File B: registers @banyancode/ConfigRepo — same shape but different tag.
        yield* repo.writeFileGraph({
          file: {
            id: "file-config",
            path: "src/config.ts",
            contentHash: "h2",
            language: "typescript",
            indexedAt: Date.now(),
          },
          nodes: [
            {
              id: "node:ConfigRepo:class",
              fileID: "file-config",
              kind: "class",
              name: "ConfigRepo",
              signature: "class ConfigRepo extends Context.Service<ConfigRepo, Interface>()",
              startLine: 5,
              endLine: 40,
              code: 'export class ConfigRepo extends Context.Service<ConfigRepo, Interface>()("@banyancode/ConfigRepo") {}',
            },
          ],
          edges: [],
        })

        // Both files landed.
        const files = yield* db.select().from(CodegraphFilesTable).all().pipe(Effect.orDie)
        const paths = files.map((f) => f.path).sort()
        expect(paths).toEqual(["src/config.ts", "src/memory.ts"])

        // Both tags resolved to the right node.
        const memory = yield* repo.lookupByServiceTag("@banyancode/MemoryRepo")
        const config = yield* repo.lookupByServiceTag("@banyancode/ConfigRepo")
        expect(memory?.id).toBe("node:MemoryRepo:class")
        expect(config?.id).toBe("node:ConfigRepo:class")

        const allTags = yield* db
          .select()
          .from(CodegraphServiceTagsTable)
          .where(eq(CodegraphServiceTagsTable.file_id, "file-memory"))
          .all()
          .pipe(Effect.orDie)
        expect(allTags.find((t) => t.tag === "@banyancode/MemoryRepo")?.node_id).toBe("node:MemoryRepo:class")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("upsert: same tag from a different node updates the canonical row (no UNIQUE conflict)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        // Initial registration.
        yield* repo.writeFileGraph({
          file: {
            id: "file-svc-1",
            path: "src/svc.ts",
            contentHash: "h1",
            language: "typescript",
            indexedAt: Date.now(),
          },
          nodes: [
            {
              id: "node:AlphaSvc:v1",
              fileID: "file-svc-1",
              kind: "class",
              name: "AlphaSvc",
              signature: "class AlphaSvc extends Context.Service<AlphaSvc, Interface>()",
              startLine: 1,
              endLine: 5,
              code: 'export class AlphaSvc extends Context.Service<AlphaSvc, Interface>()("@banyancode/Alpha") {}',
            },
          ],
          edges: [],
        })

        // Re-register the same tag from a fresh file/node_id. Previously this
        // threw a UNIQUE-constraint error and rolled back the whole file
        // transaction. After the fix, it must upsert on tag.
        yield* repo.writeFileGraph({
          file: {
            id: "file-svc-1",
            path: "src/svc.ts",
            contentHash: "h2",
            language: "typescript",
            indexedAt: Date.now(),
          },
          nodes: [
            {
              id: "node:AlphaSvc:v2",
              fileID: "file-svc-1",
              kind: "class",
              name: "AlphaSvc",
              signature: "class AlphaSvc extends Context.Service<AlphaSvc, Interface>()",
              startLine: 1,
              endLine: 5,
              code: 'export class AlphaSvc extends Context.Service<AlphaSvc, Interface>()("@banyancode/Alpha") {}',
            },
          ],
          edges: [],
        })

        const tagRows = yield* db
          .select()
          .from(CodegraphServiceTagsTable)
          .all()
          .pipe(Effect.orDie)
        const alpha = tagRows.filter((t) => t.tag === "@banyancode/Alpha")
        expect(alpha.length).toBe(1)
        expect(alpha[0]!.node_id).toBe("node:AlphaSvc:v2")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("clearAll deletes service_tags so a stale tag cannot block re-registration", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.writeFileGraph({
          file: {
            id: "file-orphan",
            path: "src/orphan.ts",
            contentHash: "h1",
            language: "typescript",
            indexedAt: Date.now(),
          },
          nodes: [
            {
              id: "node:OrphanSvc:old",
              fileID: "file-orphan",
              kind: "class",
              name: "OrphanSvc",
              signature: "class OrphanSvc extends Context.Service<OrphanSvc, Interface>()",
              startLine: 1,
              endLine: 5,
              code: 'export class OrphanSvc extends Context.Service<OrphanSvc, Interface>()("@banyancode/Orphan") {}',
            },
          ],
          edges: [],
        })

        yield* repo.clearAll({ dropFile: false })

        const afterClear = yield* db
          .select()
          .from(CodegraphServiceTagsTable)
          .all()
          .pipe(Effect.orDie)
        expect(afterClear.length).toBe(0)

        // Re-registering after clearAll must succeed and leave exactly one row.
        yield* repo.writeFileGraph({
          file: {
            id: "file-orphan",
            path: "src/orphan.ts",
            contentHash: "h2",
            language: "typescript",
            indexedAt: Date.now(),
          },
          nodes: [
            {
              id: "node:OrphanSvc:new",
              fileID: "file-orphan",
              kind: "class",
              name: "OrphanSvc",
              signature: "class OrphanSvc extends Context.Service<OrphanSvc, Interface>()",
              startLine: 1,
              endLine: 5,
              code: 'export class OrphanSvc extends Context.Service<OrphanSvc, Interface>()("@banyancode/Orphan") {}',
            },
          ],
          edges: [],
        })

        const tagsAfter = yield* db
          .select()
          .from(CodegraphServiceTagsTable)
          .all()
          .pipe(Effect.orDie)
        const orphan = tagsAfter.filter((t) => t.tag === "@banyancode/Orphan")
        expect(orphan.length).toBe(1)
        expect(orphan[0]!.node_id).toBe("node:OrphanSvc:new")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("nested generic Context.Service<Inner<T>, Interface>() still extracts the tag", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        // The old non-greedy regex matched only up to the first `>` inside the
        // generic. This fixture exercises the nested-generic shape.
        yield* repo.writeFileGraph({
          file: {
            id: "file-nested",
            path: "src/nested.ts",
            contentHash: "h1",
            language: "typescript",
            indexedAt: Date.now(),
          },
          nodes: [
            {
              id: "node:NestedSvc:1",
              fileID: "file-nested",
              kind: "class",
              name: "NestedSvc",
              signature: "class NestedSvc extends Context.Service<Box<Inner>, Interface>()",
              startLine: 1,
              endLine: 5,
              code: 'export class NestedSvc extends Context.Service<Box<Inner>, Interface>()("@banyancode/Nested") {}',
            },
          ],
          edges: [],
        })

        const hit = yield* repo.lookupByServiceTag("@banyancode/Nested")
        expect(hit?.id).toBe("node:NestedSvc:1")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
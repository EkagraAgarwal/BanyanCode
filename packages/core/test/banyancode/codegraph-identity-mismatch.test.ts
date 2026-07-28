import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { CodegraphFilesTable, CodegraphNodesTable } from "../../src/banyancode/codegraph.sql"
import { CodegraphServiceTagsTable } from "../../src/banyancode/codegraph-service-tags.sql"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(codegraphRepoDefaultLayer)

describe("CodegraphRepo.writeFileGraph identity-mismatch defense", () => {
  test("second write at same path with a different file.id does not FK-fail", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        // First pass: file with id "file-v1" and a class node tagged
        // @banyancode/Foo. previousFileID is omitted because nothing
        // exists yet, so the row is created cleanly.
        yield* repo.writeFileGraph({
          file: {
            id: "file-v1",
            path: "src/foo.ts",
            contentHash: "h1",
            language: "typescript",
            indexedAt: Date.now(),
          },
          nodes: [
            {
              id: "node:Foo:class:v1",
              fileID: "file-v1",
              kind: "class",
              name: "Foo",
              signature: "class Foo extends Context.Service<Foo, Interface>()",
              startLine: 1,
              endLine: 5,
              code: 'export class Foo extends Context.Service<Foo, Interface>()("@banyancode/Foo") {}',
            },
          ],
          edges: [],
        })

        // Second pass: same path, but a DIFFERENT file.id ("file-v2"). This
        // simulates a re-index pass that regenerated ids (e.g. after a
        // partial-failure recovery where the file row survived but the
        // nodes did not). Without the identity-mismatch defense this throws
        // SQLITE_CONSTRAINT_FOREIGNKEY because the new node references
        // file_id="file-v2" but the existing row at that path still has
        // id="file-v1".
        yield* repo.writeFileGraph({
          file: {
            id: "file-v2",
            path: "src/foo.ts",
            contentHash: "h2",
            language: "typescript",
            indexedAt: Date.now(),
          },
          nodes: [
            {
              id: "node:Foo:class:v2",
              fileID: "file-v2",
              kind: "class",
              name: "Foo",
              signature: "class Foo extends Context.Service<Foo, Interface>()",
              startLine: 1,
              endLine: 5,
              code: 'export class Foo extends Context.Service<Foo, Interface>()("@banyancode/Foo") {}',
            },
          ],
          edges: [],
        })

        // The file row at this path must now have id = "file-v2".
        const fileRow = yield* db
          .select()
          .from(CodegraphFilesTable)
          .where(eq(CodegraphFilesTable.path, "src/foo.ts"))
          .all()
          .pipe(Effect.orDie)
        // Exactly one row, and its id must be the NEW (post-upsert) id —
        // if a future refactor silently drops `id: input.file.id` from the
        // upsert's `set` block, the file row would still hold the old id
        // and the next node insert would FK-fail again.
        expect(fileRow.length).toBe(1)
        expect(fileRow[0]!.id).toBe("file-v2")

        // The service-tag entry must point to the new node id and have the
        // new file_id. There must NOT be two tag rows for the same tag.
        const tags = yield* db
          .select()
          .from(CodegraphServiceTagsTable)
          .all()
          .pipe(Effect.orDie)
        const foo = tags.filter((t: any) => t.tag === "@banyancode/Foo")
        expect(foo.length).toBe(1)
        expect(foo[0]!.node_id).toBe("node:Foo:class:v2")
        expect(foo[0]!.file_id).toBe("file-v2")

        // Cascade defense: only nodes referencing the new file_id remain,
        // and the v1 node has been cascade-deleted with the old file row.
        const remainingNodes = yield* db
          .select()
          .from(CodegraphNodesTable)
          .all()
          .pipe(Effect.orDie)
        expect(remainingNodes.length).toBe(1)
        expect(remainingNodes[0]!.id).toBe("node:Foo:class:v2")
        expect(remainingNodes[0]!.file_id).toBe("file-v2")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

// Light-projection regression test: full-graph scans must not load the
// `code` column (bodies dominate row bytes). listNodesLightPage pages with a
// SELECT that omits `code`; searchNodesLight filters server-side.
describe("codegraph light projections", () => {
  test("listNodesLightPage omits code and pages by cursor", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "test.db"))

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "file-a",
          path: "src/a.ts",
          contentHash: "h1",
          language: "typescript",
          indexedAt: 1,
        })
        for (const n of ["n1", "n2", "n3"]) {
          yield* repo.putNode({
            id: n,
            fileID: "file-a",
            kind: "function",
            name: `fn${n}`,
            signature: `fn${n}()`,
            startLine: 1,
            endLine: 50,
            code: `function fn${n}() { /* ${"x".repeat(5000)} */ }`,
          })
        }

        const page1 = yield* repo.listNodesLightPage({ limit: 2 })
        expect(page1.nodes.map((n) => n.id)).toEqual(["n1", "n2"])
        for (const n of page1.nodes) expect("code" in n).toBe(false)
        expect(page1.nextCursor).toBe("n2")

        const page2 = yield* repo.listNodesLightPage({ cursor: page1.nextCursor, limit: 2 })
        expect(page2.nodes.map((n) => n.id)).toEqual(["n3"])
        for (const n of page2.nodes) expect("code" in n).toBe(false)
        expect(page2.nextCursor).toBeUndefined()

        // Contrast: the full loader still carries bodies.
        const full = yield* repo.listAllNodes()
        expect(full).toHaveLength(3)
        for (const n of full) expect(n.code).toContain("function fn")

        expect(yield* repo.countNodes()).toBe(3)
      }).pipe(Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("searchNodesLight filters server-side without code bodies", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "test.db"))

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "file-a",
          path: "src/a.ts",
          contentHash: "h1",
          language: "typescript",
          indexedAt: 1,
        })
        yield* repo.putNode({
          id: "n1",
          fileID: "file-a",
          kind: "function",
          name: "buildService",
          startLine: 1,
          endLine: 10,
          code: "function buildService() {}",
        })
        yield* repo.putNode({
          id: "n2",
          fileID: "file-a",
          kind: "function",
          name: "otherThing",
          startLine: 11,
          endLine: 20,
          code: "function otherThing() {}",
        })

        const hits = yield* repo.searchNodesLight({ name: "build", limit: 10 })
        expect(hits.map((n) => n.name)).toEqual(["buildService"])
        for (const n of hits) expect("code" in n).toBe(false)
      }).pipe(Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

/**
 * Phase 3d-followup regression: full rebuilds must purge pre-existing
 * derived edges. Before the fix, full rebuild inserted derived edges with
 * `onConflictDoNothing` and never deleted; in production this let ~166K
 * stale edges accumulate over ~1800 builds (18,971 vs 185,012 total edge
 * count, reported by the post-release tool exercise).
 *
 * Both tests work via the `CodegraphRepo` service and exercise the
 * purge path directly via `writeFileGraph` (deterministic IDs), so the
 * assertions are independent of whether the test bundle has tree-sitter
 * available.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as path from "path"
import { Banyan } from "@opencode-ai/core/banyancode"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

describe("full rebuild derived-edge purge", () => {
  test("deleteAllDerivedEdges removes derived kinds, keeps parser kinds", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const layer = Banyan.codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        // Seed file A with both a parser edge (imports) and a derived
        // edge (calls).
        yield* repo.writeFileGraph({
          file: { id: "f-a", path: "/abs/a.ts", contentHash: "h-a", language: "typescript", indexedAt: Date.now() },
          nodes: [
            { id: "f-a:file", fileID: "f-a", kind: "file", name: "a.ts", startLine: 1, endLine: 1 },
            { id: "f-a:class:A:1", fileID: "f-a", kind: "class", name: "A", startLine: 1, endLine: 2 },
          ],
          edges: [
            { id: "f-a:file->f-a:class:A:1:imports", fromNodeID: "f-a:file", toNodeID: "f-a:class:A:1", kind: "imports" },
            { id: "f-a:class:A:1->f-a:file:calls", fromNodeID: "f-a:class:A:1", toNodeID: "f-a:file", kind: "calls" },
          ],
        })

        // Seed file B with a parser edge and several derived edges of
        // every kind in the purge set. Covers calls / extends /
        // references / tested_by and confirms the parsed edge survives.
        yield* repo.writeFileGraph({
          file: { id: "f-b", path: "/abs/b.ts", contentHash: "h-b", language: "typescript", indexedAt: Date.now() },
          nodes: [
            { id: "f-b:file", fileID: "f-b", kind: "file", name: "b.ts", startLine: 1, endLine: 1 },
            { id: "f-b:function:helper:1", fileID: "f-b", kind: "function", name: "helper", startLine: 1, endLine: 2 },
          ],
          edges: [
            { id: "f-b:file->f-b:function:helper:1:imports", fromNodeID: "f-b:file", toNodeID: "f-b:function:helper:1", kind: "imports" },
            { id: "f-b:function:helper:1->f-a:class:A:1:extends", fromNodeID: "f-b:function:helper:1", toNodeID: "f-a:class:A:1", kind: "extends" },
            { id: "f-b:function:helper:1->f-a:class:A:1:references", fromNodeID: "f-b:function:helper:1", toNodeID: "f-a:class:A:1", kind: "references" },
            { id: "f-b:function:helper:1->f-a:class:A:1:tested_by", fromNodeID: "f-b:function:helper:1", toNodeID: "f-a:class:A:1", kind: "tested_by" },
          ],
        })

        const derivedSet = new Set(["calls", "extends", "references", "tested_by", "configured_by", "built_by", "mounts", "generated_from"])
        const before = yield* repo.listAllEdges()
        const derivedBefore = before.filter((e) => derivedSet.has(e.kind))
        const parserBefore = before.filter((e) => e.kind === "imports")
        expect(derivedBefore.length).toBe(4) // calls + extends + references + tested_by
        expect(parserBefore.length).toBe(2)

        const purgedIDs = yield* repo.deleteAllDerivedEdges()
        expect(purgedIDs.length).toBeGreaterThan(0)
        expect(purgedIDs.includes("f-a:class:A:1")).toBe(true)
        expect(purgedIDs.includes("f-b:function:helper:1")).toBe(true)

        const after = yield* repo.listAllEdges()
        const derivedAfter = after.filter((e) => derivedSet.has(e.kind))
        const parserAfter = after.filter((e) => e.kind === "imports")
        expect(derivedAfter.length).toBe(0)
        expect(parserAfter.length).toBe(2)
        const importsIDs = parserAfter.map((e) => e.id).sort()
        expect(importsIDs).toEqual([
          "f-a:file->f-a:class:A:1:imports",
          "f-b:file->f-b:function:helper:1:imports",
        ])
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  })

  test("the full-rebuild purge keeps `imports` parser edges even when a derived edge targets one of the same endpoints", async () => {
    // Direct unit check of the SQL `WHERE kind IN (...)` clause: a bogus
    // derived edge and a legitimate parser edge between identical
    // endpoints must differ only in kind, so the parser edge survives
    // the purge intact.
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const layer = Banyan.codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        yield* repo.writeFileGraph({
          file: { id: "f-x", path: "/abs/x.ts", contentHash: "h", language: "typescript", indexedAt: Date.now() },
          nodes: [
            { id: "f-x:file", fileID: "f-x", kind: "file", name: "x.ts", startLine: 1, endLine: 1 },
            { id: "f-x:class:X:1", fileID: "f-x", kind: "class", name: "X", startLine: 1, endLine: 2 },
          ],
          edges: [
            { id: "f-x:file->f-x:class:X:1:imports", fromNodeID: "f-x:file", toNodeID: "f-x:class:X:1", kind: "imports" },
            { id: "f-x:file->f-x:class:X:1:references", fromNodeID: "f-x:file", toNodeID: "f-x:class:X:1", kind: "references" },
          ],
        })

        const before = yield* repo.listAllEdges()
        expect(before.length).toBe(2)

        yield* repo.deleteAllDerivedEdges()

        const after = yield* repo.listAllEdges()
        expect(after.length).toBe(1)
        expect(after[0].kind).toBe("imports")
        expect(after[0].id).toBe("f-x:file->f-x:class:X:1:imports")
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  })
})

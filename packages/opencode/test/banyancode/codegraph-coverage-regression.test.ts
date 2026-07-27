/**
 * Phase 0 regression: graphCoverage must mean "fraction of the repo's
 * eligible candidate files that are present in the graph", NOT
 * "fraction of files re-parsed this run". Before Phase 0, a fully-cached
 * rebuild reported coverage of `0/N` (e.g. 50/3000 = 1.67%) because the
 * caller fed `result.indexed` (files parsed THIS run) into the numerator
 * and `result.scannedFiles` (indexed + 9 skip buckets, including cached)
 * into the denominator. Tools and the TUI pill then permanently flagged
 * the build as stale.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as path from "path"
import { Banyan } from "@opencode-ai/core/banyancode"
import { CodegraphBuildService } from "@opencode-ai/core/banyancode/codegraph-build-service"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { NodeFileSystem } from "@effect/platform-node"
import { tmpdir } from "../fixture/tmpdir"
import { pollWithTimeout } from "../lib/effect"

process.env.BANYANCODE_ENABLE = "1"

const FIXTURE_FILES = [
  `export function add(a: number, b: number): number { return a + b }
export const VERSION = "1.0.0"
`,
  `export function multiply(a: number, b: number): number { return a * b }
export class Helper { greet() { return "hi" } }
`,
  `import { add } from "./file0"
export function compute(n: number): number { return add(n, 1) }
`,
]

// Writes the fixture into a `src/` subdir so the test database (which
// lives at the parent) doesn't get walked as an extra eligible file.
async function writeFixture(root: string): Promise<string> {
  const srcDir = path.join(root, "src")
  for (let i = 0; i < FIXTURE_FILES.length; i++) {
    await Bun.write(path.join(srcDir, `file${i}.ts`), FIXTURE_FILES[i])
  }
  return srcDir
}

const waitForState = (
  buildSvc: CodegraphBuildService.Interface,
  target: "completed" | "failed",
): Effect.Effect<CodegraphBuildService.State, Error, never> =>
  pollWithTimeout(
    Effect.gen(function* () {
      const s = yield* buildSvc.status()
      if (s.status === target) return s
      return undefined
    }),
    `build never reached ${target}`,
    "30 seconds",
  ) as Effect.Effect<CodegraphBuildService.State, Error, never>

function makeTestLayer(dbPath: string) {
  const dbLayer = Database.layerFromPath(dbPath)
  const repoLayer = Banyan.codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))
  const buildLayer = Banyan.codegraphBuildServiceDefaultLayer.pipe(Layer.provide(dbLayer))
  return Layer.merge(repoLayer, buildLayer).pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(EventV2.defaultLayer),
  )
}

describe("Phase 0 - graphCoverage is indexedFiles / eligibleFiles", () => {
  test("a second consecutive build over an unchanged tree reports coverage >= 0.95", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    const srcDir = await writeFixture(dir)
    const dbPath = path.join(dir, "test.sqlite")
    const layer = makeTestLayer(dbPath)

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const buildSvc = yield* CodegraphBuildService.Service
        const repo = yield* CodegraphRepo.Service

        yield* buildSvc.start({ root: srcDir, force: true })
        const first = yield* waitForState(buildSvc, "completed")

        const firstMeta = yield* repo.getMeta()

        yield* buildSvc.start({ root: srcDir, force: false })
        const second = yield* waitForState(buildSvc, "completed")

        const secondMeta = yield* repo.getMeta()
        const dbNodes = yield* repo.countNodes()
        const dbEdges = yield* repo.countEdges()

        return { first, firstMeta, second, secondMeta, dbNodes, dbEdges }
      }).pipe(Effect.provide(layer), Effect.scoped),
    )

    expect(outcome.first.status).toBe("completed")
    expect(outcome.first.graphCoverage ?? 0).toBeGreaterThanOrEqual(0.95)
    expect(outcome.firstMeta?.totalFiles).toBe(FIXTURE_FILES.length)

    expect(outcome.second.status).toBe("completed")

    // The OLD formula scored this at indexed=0/scanned=3 = 0 because
    // every file was a content-hash cache hit. The Phase 0 formula -
    // rows in codegraph_files over the walker's eligibleFiles - keeps
    // coverage >= 0.95 even on a no-op rebuild.
    expect(outcome.second.graphCoverage ?? 0).toBeGreaterThanOrEqual(0.95)
    expect(outcome.second.graphCoverage ?? 0).not.toBeLessThan(0.05)

    expect(outcome.secondMeta).toBeDefined()
    expect(outcome.secondMeta?.graphVersion ?? 0).toBeGreaterThan(
      outcome.firstMeta?.graphVersion ?? 0,
    )
    expect(outcome.secondMeta?.graphCoverage ?? 0).toBeGreaterThanOrEqual(0.95)

    // Phase 0 invariant: totalNodes / totalEdges are derived from
    // countNodes() / countEdges() inside bumpVersion, not from the
    // caller. They reflect what's actually in the DB, not whatever
    // count the indexer happened to pass in.
    expect(outcome.secondMeta?.totalNodes).toBe(outcome.dbNodes)
    expect(outcome.secondMeta?.totalEdges).toBe(outcome.dbEdges)
    expect(outcome.secondMeta?.totalNodes).toBe(outcome.firstMeta?.totalNodes ?? 0)
    expect(outcome.secondMeta?.totalEdges).toBe(outcome.firstMeta?.totalEdges ?? 0)
  }, 60000)
})

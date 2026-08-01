import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "../../src/database/database"
import { VerificationRepo } from "../../src/banyancode/verification-repo"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const buildLayer = (dbPath: string) => VerificationRepo.defaultLayer.pipe(Layer.provide(Database.layerFromPath(dbPath)))

const withRepo = async <A>(run: (repo: VerificationRepo.Interface) => Effect.Effect<A, never, never>): Promise<A> => {
  await using tmp = await tmpdir()
  const dbPath = path.join(tmp.path, "test.sqlite")
  const program = Effect.gen(function* () {
    const repo = yield* VerificationRepo.Service
    return yield* run(repo as unknown as VerificationRepo.Interface)
  }).pipe(Effect.provide(buildLayer(dbPath)))
  return await Effect.runPromise(program)
}

describe("VerificationRepo", () => {
  test("recordStart inserts a running row and returns an incrementing id", async () => {
    const result = await withRepo((repo) =>
      Effect.gen(function* () {
        const first = yield* repo.recordStart({ kind: "typecheck", target: "src/a.ts" })
        const second = yield* repo.recordStart({ kind: "test", target: "src/b.test.ts" })
        const recent = yield* repo.findRecent({ limit: 10 })
        return { first, second, recent }
      }),
    )
    expect(typeof result.first).toBe("number")
    expect(result.second).toBeGreaterThan(result.first)
    // Both rows are still in-flight, so they carry status "running" and no
    // completion timestamp.
    expect(result.recent).toHaveLength(2)
    for (const row of result.recent) {
      expect(row.status).toBe("running")
      expect(row.completedAt).toBeUndefined()
      expect(row.durationMs).toBeUndefined()
    }
  })

  test("recordComplete transitions status and populates completion fields", async () => {
    const run = await withRepo((repo) =>
      Effect.gen(function* () {
        const id = yield* repo.recordStart({ kind: "test", target: "src/x.test.ts" })
        return yield* repo.recordComplete({
          id,
          status: "failed",
          durationMs: 1234,
          summary: { passed: 3, failed: 1, skipped: 0, errored: 0 },
          rawOutput: "3 pass\n1 fail",
        })
      }),
    )
    expect(run.status).toBe("failed")
    expect(run.durationMs).toBe(1234)
    expect(run.completedAt).toBeDefined()
    expect(run.rawOutput).toBe("3 pass\n1 fail")
  })

  test("summary round-trips through the JSON column", async () => {
    const run = await withRepo((repo) =>
      Effect.gen(function* () {
        const id = yield* repo.recordStart({ kind: "test", target: "suite" })
        yield* repo.recordComplete({
          id,
          status: "passed",
          durationMs: 10,
          summary: { passed: 42, failed: 0, skipped: 7, errored: 0 },
        })
        // Re-read through a separate query path so we exercise mapRow's JSON
        // decode rather than the value recordComplete happened to hold.
        const recent = yield* repo.findRecent({ kind: "test", limit: 1 })
        return recent[0]!
      }),
    )
    expect(run.summary).toEqual({ passed: 42, failed: 0, skipped: 7, errored: 0 })
  })

  test("a run with no summary reads back as undefined, not null", async () => {
    const run = await withRepo((repo) =>
      Effect.gen(function* () {
        const id = yield* repo.recordStart({ kind: "typecheck", target: "." })
        return yield* repo.recordComplete({ id, status: "passed", durationMs: 5 })
      }),
    )
    expect(run.summary).toBeUndefined()
    expect(run.rawOutput).toBeUndefined()
  })

  test("findByCacheKey returns the completed row on hit and undefined on miss", async () => {
    const result = await withRepo((repo) =>
      Effect.gen(function* () {
        const id = yield* repo.recordStart({ kind: "typecheck", target: ".", cacheKey: "key-hit" })
        yield* repo.recordComplete({ id, status: "passed", durationMs: 99 })
        const hit = yield* repo.findByCacheKey({ cacheKey: "key-hit" })
        const miss = yield* repo.findByCacheKey({ cacheKey: "key-absent" })
        return { hit, miss }
      }),
    )
    expect(result.hit).toBeDefined()
    expect(result.hit!.status).toBe("passed")
    expect(result.hit!.durationMs).toBe(99)
    expect(result.miss).toBeUndefined()
  })

  test("findByCacheKey ignores still-running rows", async () => {
    // A run that started but never completed must not be served as a cache
    // hit — otherwise a crashed verifier would poison the cache with a row
    // that has no status. The repo filters `status != 'running'`.
    const hit = await withRepo((repo) =>
      Effect.gen(function* () {
        yield* repo.recordStart({ kind: "lint", target: ".", cacheKey: "key-running" })
        return yield* repo.findByCacheKey({ cacheKey: "key-running" })
      }),
    )
    expect(hit).toBeUndefined()
  })

  test("findRecent filters by kind and respects the limit", async () => {
    const result = await withRepo((repo) =>
      Effect.gen(function* () {
        for (const kind of ["typecheck", "test", "test", "lint"] as const) {
          const id = yield* repo.recordStart({ kind, target: `${kind}-target` })
          yield* repo.recordComplete({ id, status: "passed", durationMs: 1 })
        }
        const onlyTests = yield* repo.findRecent({ kind: "test", limit: 10 })
        const capped = yield* repo.findRecent({ limit: 2 })
        const all = yield* repo.findRecent({ limit: 100 })
        return { onlyTests, capped, all }
      }),
    )
    expect(result.onlyTests).toHaveLength(2)
    for (const row of result.onlyTests) expect(row.kind).toBe("test")
    expect(result.capped).toHaveLength(2)
    expect(result.all).toHaveLength(4)
  })

  test("findRecent clamps a zero or negative limit up to one row", async () => {
    const rows = await withRepo((repo) =>
      Effect.gen(function* () {
        const id = yield* repo.recordStart({ kind: "compile", target: "." })
        yield* repo.recordComplete({ id, status: "passed", durationMs: 1 })
        return yield* repo.findRecent({ limit: 0 })
      }),
    )
    expect(rows).toHaveLength(1)
  })
})
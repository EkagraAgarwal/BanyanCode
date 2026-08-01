import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { AppProcess } from "../../src/process"
import { CrossSpawnSpawner } from "../../src/cross-spawn-spawner"
import { Database } from "../../src/database/database"
import { FSUtil } from "../../src/fs-util"
import { BanyanConfigService } from "../../src/banyancode/banyan-config"
import { VerificationRepo } from "../../src/banyancode/verification-repo"
import { VerifierService } from "../../src/banyancode/verifier-service"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

// The verifier shells out for real (no mocks, per AGENTS.md). We drive it
// through `bun test` against throwaway fixture projects rather than `bunx tsc`
// so the suite stays hermetic and fast — `tsc` would need a resolved install
// and dominate the runtime. The code path under test (`executeAndRecord`) is
// shared by all four verification kinds, so exercising it via `test` covers
// caching, persistence, summary parsing, and output truncation for the rest.

const buildLayer = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
  return VerifierService.layer.pipe(
    Layer.provide(AppProcess.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(BanyanConfigService.defaultLayer.pipe(Layer.provide(FSUtil.defaultLayer))),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(VerificationRepo.layer.pipe(Layer.provide(dbLayer))),
  )
}

const PASSING_TEST = `import { test, expect } from "bun:test"
test("a", () => { expect(1).toBe(1) })
test("b", () => { expect(2).toBe(2) })
`

const FAILING_TEST = `import { test, expect } from "bun:test"
test("ok", () => { expect(1).toBe(1) })
test("bad", () => { expect(1).toBe(2) })
`

const NOISY_TEST = `import { test } from "bun:test"
test("noisy", () => { console.log("x".repeat(200000)) })
`

const makeProject = async (root: string, files: Record<string, string>) => {
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }), "utf8")
  for (const [name, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), contents, "utf8")
  }
}

const withVerifier = async <A>(
  run: (verifier: VerifierService.Interface, root: string) => Effect.Effect<A, never, never>,
  files: Record<string, string>,
): Promise<A> => {
  await using tmp = await tmpdir()
  const root = tmp.path
  await makeProject(root, files)
  const program = Effect.gen(function* () {
    const verifier = yield* VerifierService.Service
    return yield* run(verifier as unknown as VerifierService.Interface, root)
  }).pipe(Effect.provide(buildLayer(path.join(root, "verify.sqlite"))))
  return await Effect.runPromise(program)
}

describe("VerifierService", () => {
  test(
    "test on a passing suite reports passed and parses the bun summary",
    async () => {
      const result = await withVerifier(
        (verifier, root) => verifier.test({ path: path.join(root, "pass.test.ts"), projectRoot: root }),
        { "pass.test.ts": PASSING_TEST },
      )
      expect(result.kind).toBe("test")
      expect(result.status).toBe("passed")
      expect(result.cacheHit).toBe(false)
      expect(result.summary.passed).toBe(2)
      expect(result.summary.failed).toBe(0)
      expect(result.durationMs).toBeGreaterThan(0)
    },
    60_000,
  )

  test(
    "test on a failing suite reports failed with the failure count",
    async () => {
      const result = await withVerifier(
        (verifier, root) => verifier.test({ path: path.join(root, "fail.test.ts"), projectRoot: root }),
        { "fail.test.ts": FAILING_TEST },
      )
      expect(result.status).toBe("failed")
      expect(result.summary.passed).toBe(1)
      expect(result.summary.failed).toBe(1)
    },
    60_000,
  )

  test(
    "a second identical run is served from cache",
    async () => {
      const result = await withVerifier(
        (verifier, root) =>
          Effect.gen(function* () {
            const target = path.join(root, "pass.test.ts")
            const first = yield* verifier.test({ path: target, projectRoot: root })
            const second = yield* verifier.test({ path: target, projectRoot: root })
            return { first, second }
          }),
        { "pass.test.ts": PASSING_TEST },
      )
      expect(result.first.cacheHit).toBe(false)
      expect(result.second.cacheHit).toBe(true)
      // The cached row replays the original outcome rather than re-deriving it.
      expect(result.second.status).toBe(result.first.status)
      expect(result.second.summary).toEqual(result.first.summary)
    },
    90_000,
  )

  test(
    "a different target does not collide with an existing cache entry",
    async () => {
      const result = await withVerifier(
        (verifier, root) =>
          Effect.gen(function* () {
            const first = yield* verifier.test({ path: path.join(root, "pass.test.ts"), projectRoot: root })
            const second = yield* verifier.test({ path: path.join(root, "other.test.ts"), projectRoot: root })
            return { first, second }
          }),
        { "pass.test.ts": PASSING_TEST, "other.test.ts": PASSING_TEST },
      )
      expect(result.first.cacheHit).toBe(false)
      // The cache key folds in the resolved target path, so a sibling file is a
      // miss even though the command shape and project root are identical.
      expect(result.second.cacheHit).toBe(false)
    },
    90_000,
  )

  test(
    "each run is persisted to verification_runs",
    async () => {
      await using tmp = await tmpdir()
      const root = tmp.path
      await makeProject(root, { "pass.test.ts": PASSING_TEST })
      const dbPath = path.join(root, "verify.sqlite")
      const dbLayer = Database.layerFromPath(dbPath)

      const program = Effect.gen(function* () {
        const verifier = yield* VerifierService.Service
        yield* verifier.test({ path: path.join(root, "pass.test.ts"), projectRoot: root })
        const repo = yield* VerificationRepo.Service
        return yield* repo.findRecent({ kind: "test", limit: 10 })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            buildLayer(dbPath),
            VerificationRepo.layer.pipe(Layer.provide(dbLayer)),
          ),
        ),
      )

      const rows = await Effect.runPromise(program)
      expect(rows.length).toBeGreaterThanOrEqual(1)
      const row = rows[0]!
      expect(row.kind).toBe("test")
      expect(row.status).toBe("passed")
      expect(row.cacheKey).toBeDefined()
      expect(row.completedAt).toBeDefined()
    },
    60_000,
  )

  test(
    "a target that cannot be run fails without throwing",
    async () => {
      // `bun test <missing path>` exits non-zero. The service must surface that
      // as a structured `failed` result rather than letting the process error
      // escape — runShell catches the cause and synthesises an exit code.
      const result = await withVerifier(
        (verifier, root) => verifier.test({ path: path.join(root, "does-not-exist.test.ts"), projectRoot: root }),
        {},
      )
      expect(["failed", "errored"]).toContain(result.status)
      expect(result.cacheHit).toBe(false)
    },
    60_000,
  )

  test(
    "raw output is capped at the 64 KB tail limit",
    async () => {
      const result = await withVerifier(
        (verifier, root) => verifier.test({ path: path.join(root, "noisy.test.ts"), projectRoot: root }),
        { "noisy.test.ts": NOISY_TEST },
      )
      expect(result.rawOutput).toBeDefined()
      // 64 KB per stream from maxOutputBytes, then truncateTail over the
      // combined stdout+stderr. Allow one extra stream's worth of slack.
      expect(Buffer.byteLength(result.rawOutput!, "utf8")).toBeLessThanOrEqual(64 * 1024 + 1)
    },
    60_000,
  )
})
import { afterEach, describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { BanyanConfig } from "../../src/config/index.js"
import { Storage } from "../../src/storage/index.js"
import { handlers } from "../../src/verify/rpc.js"
import { make, withinProject } from "../../src/verify/service.js"

/**
 * Real tiny Bun project in a temp dir; real processes for `bun run typecheck`,
 * `bun test <path>`, and a user `commands.lint` override. Every run is
 * persisted to the real `verification_runs` table in a real project DB.
 */

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

const resolveTsc = async (): Promise<string> => {
  const require = createRequire(import.meta.url)
  const packageJsonPath = require.resolve("typescript/package.json")
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { bin?: Record<string, string> | string }
  const bin = typeof packageJson.bin === "string" ? packageJson.bin : Object.values(packageJson.bin ?? {})[0]
  if (!bin) throw new Error("typescript package has no bin entry")
  return join(dirname(packageJsonPath), bin)
}

const withProject = async (
  fn: (root: string) => Promise<void>,
  options: { failingTypecheck?: boolean } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "banyancode-verify-"))
  roots.push(root)
  await mkdir(join(root, "src"), { recursive: true })

  const typecheckScript = `${JSON.stringify(process.execPath)} ${JSON.stringify(await resolveTsc())} --noEmit -p tsconfig.json`
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "tiny-verify-project", private: true, scripts: { typecheck: typecheckScript } }, null, 2),
    "utf8",
  )
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          skipLibCheck: true,
          types: [],
        },
        include: ["src/sum.ts"],
      },
      null,
      2,
    ),
    "utf8",
  )
  await writeFile(
    join(root, "src", "sum.ts"),
    options.failingTypecheck
      ? "export const sum = (a: number, b: number): string => a + b\n"
      : "export const sum = (a: number, b: number): number => a + b\n",
    "utf8",
  )
  await writeFile(
    join(root, "src", "sum.test.ts"),
    [
      'import { expect, test } from "bun:test"',
      'import { sum } from "./sum"',
      'test("sum adds", () => {',
      "  expect(sum(1, 2)).toBe(3)",
      "})",
    ].join("\n"),
    "utf8",
  )
  await writeFile(join(root, "lint.js"), 'console.log("lint-ok")\n', "utf8")
  await writeFile(
    join(root, "banyancode.json"),
    JSON.stringify({ commands: { lint: `${JSON.stringify(process.execPath)} lint.js` } }, null, 2),
    "utf8",
  )

  await fn(root)
}

interface RunRow {
  readonly kind: string
  readonly target: string
  readonly status: string
  readonly duration_ms: number | null
  readonly summary: string | null
  readonly raw_output: string | null
  readonly cache_key: string | null
}

const openDeps = (root: string) =>
  Effect.gen(function* () {
    // Keep the DB inside the temp root so the test is hermetic even when the
    // storage layer defaults to the product data dir.
    const storage = yield* Storage.open({
      projectRoot: root,
      env: { BANYANCODE_PROJECT_DB_DIR: join(root, ".banyancode-db") },
    })
    const config = BanyanConfig.make({
      directory: root,
      projectRoot: root,
      globalDir: join(root, "no-global-config"),
      home: root,
      env: {},
    })
    return { storage, verifier: make({ storage, config }) }
  })

describe("verify service", () => {
  test("typecheck runs the project script and caches the run for one hour", async () => {
    await withProject(async (root) => {
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { storage, verifier } = yield* openDeps(root)
            const first = yield* verifier.typecheck({ projectRoot: root })
            const second = yield* verifier.typecheck({ projectRoot: root })
            const rows = yield* storage.query<RunRow>(
              "SELECT kind, target, status, duration_ms, summary, raw_output, cache_key FROM verification_runs ORDER BY id",
            )
            return { first, second, rows }
          }),
        ),
      )

      expect(outcome.first.status).toBe("passed")
      expect(outcome.first.cacheHit).toBe(false)
      expect(outcome.first.command).toContain("bun run typecheck")
      expect(outcome.first.durationMs).toBeGreaterThanOrEqual(0)
      expect(outcome.second.cacheHit).toBe(true)
      expect(outcome.second.status).toBe("passed")

      expect(outcome.rows.length).toBe(1)
      expect(outcome.rows[0]?.kind).toBe("typecheck")
      expect(outcome.rows[0]?.status).toBe("passed")
      expect(outcome.rows[0]?.duration_ms).not.toBeNull()
      expect(outcome.rows[0]?.cache_key?.length).toBe(16)
      expect(JSON.parse(outcome.rows[0]?.summary ?? "{}")).toEqual({})
    })
  })

  test("a real bun test run is parsed and recorded separately", async () => {
    await withProject(async (root) => {
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { storage, verifier } = yield* openDeps(root)
            const result = yield* verifier.test({ path: "src/sum.test.ts", projectRoot: root })
            const rows = yield* storage.query<RunRow>(
              "SELECT kind, target, status, duration_ms, summary, raw_output, cache_key FROM verification_runs ORDER BY id",
            )
            return { result, rows }
          }),
        ),
      )

      expect(outcome.result.status).toBe("passed")
      expect(outcome.result.command).toBe(`bun test ${join(root, "src", "sum.test.ts")}`)
      expect(outcome.result.summary.passed).toBe(1)
      expect(outcome.result.summary.failed).toBe(0)
      expect(outcome.rows.length).toBe(1)
      expect(outcome.rows[0]?.kind).toBe("test")
      expect(outcome.rows[0]?.status).toBe("passed")
      expect(outcome.rows[0]?.raw_output).toContain("pass")
    })
  })

  test("commands.lint override runs through the shell", async () => {
    await withProject(async (root) => {
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { storage, verifier } = yield* openDeps(root)
            const result = yield* verifier.lint({ projectRoot: root })
            const rows = yield* storage.query<RunRow>(
              "SELECT kind, target, status, duration_ms, summary, raw_output, cache_key FROM verification_runs ORDER BY id",
            )
            return { result, rows }
          }),
        ),
      )

      expect(outcome.result.status).toBe("passed")
      expect(outcome.result.command).toBe(`${JSON.stringify(process.execPath)} lint.js`)
      expect(outcome.result.rawOutput).toContain("lint-ok")
      expect(outcome.rows[0]?.kind).toBe("lint")
      expect(outcome.rows[0]?.status).toBe("passed")
    })
  })

  test("a failing typecheck reports failed and records the failure", async () => {
    await withProject(
      async (root) => {
        const outcome = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const { storage, verifier } = yield* openDeps(root)
              const result = yield* verifier.typecheck({ projectRoot: root })
              const rows = yield* storage.query<RunRow>(
                "SELECT kind, target, status, duration_ms, summary, raw_output, cache_key FROM verification_runs ORDER BY id",
              )
              return { result, rows }
            }),
          ),
        )

        expect(outcome.result.status).toBe("failed")
        expect(outcome.result.rawOutput).toContain("error TS")
        expect(outcome.rows[0]?.status).toBe("failed")
      },
      { failingTypecheck: true },
    )
  })

  test("path containment rejects escapes before spawning", async () => {
    expect(withinProject("C:/repo", "src/a.ts")).toBe(true)
    expect(withinProject("C:/repo", "../outside.ts")).toBe(false)
    expect(withinProject("C:/repo", "../repo-other/x.ts")).toBe(false)
  })

  test("RPC handlers default projectRoot to the registered location", async () => {
    const roots: string[] = []
    const verifier = {
      detect: () => Effect.die("unused"),
      typecheck: (input: { projectRoot?: string }) =>
        Effect.sync(() => {
          roots.push(input.projectRoot ?? "")
          return {
            kind: "typecheck" as const,
            target: input.projectRoot ?? "",
            status: "passed" as const,
            summary: {},
            durationMs: 1,
            cacheHit: false,
            rawOutput: undefined,
            command: "bun run typecheck",
          }
        }),
      test: () => Effect.die("unused"),
      lint: () => Effect.die("unused"),
      compile: () => Effect.die("unused"),
    }
    const rpc = handlers(verifier as never, { projectRoot: "/ctx/project" })
    const rpcContext = { error: () => { throw new Error("unexpected rpc error") } } as never
    const result = await Effect.runPromise(rpc.typecheck({}, rpcContext))
    expect(result.status).toBe("passed")
    expect(roots).toEqual(["/ctx/project"])
  })
})

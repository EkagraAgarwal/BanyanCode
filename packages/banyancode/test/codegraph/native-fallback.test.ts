/**
 * Native backend fallback.
 *
 * The sidecar is an optimisation, never a dependency: if it is missing, fails
 * to spawn, speaks the wrong protocol version, crashes mid-stream or emits a
 * line that is not JSON, the build must finish on the TypeScript parser with
 * one logged warning and a `backend` value that says so.
 *
 * These tests use a REAL executable (compiled with `bun build --compile`) that
 * behaves badly in each of those ways, so the failure travels through the same
 * spawn/pipe/parse path production does. No mocks.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Storage } from "../../src/storage/index.js"
import { make as makeRepo } from "../../src/codegraph/codegraph-repo.js"
import { make as makeIndexer } from "../../src/codegraph/codegraph-indexer.js"

const tempDirs: string[] = []

const makeTemp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** A compiled executable that misbehaves exactly as `behaviour` says. */
const buildFakeSidecar = async (behaviour: "malformed" | "crash" | "bad-protocol" | "short"): Promise<string> => {
  const dir = await makeTemp("banyan-fake-sidecar-")
  const script = join(dir, "fake.ts")
  const exe = join(dir, process.platform === "win32" ? "banyan-indexer.exe" : "banyan-indexer")
  const body = `
const lines = (await Bun.stdin.text()).split("\\n")
const request = JSON.parse(lines[0]!)
const protocol = ${behaviour === "bad-protocol" ? "999" : "1"}
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\\n")
emit({ type: "hello", protocol, version: "fake", backends: ["tree-sitter"] })
const first = request.files[0]
if (first) {
  emit({
    type: "file",
    path: first.path,
    relativePath: first.path.slice(request.root.length + 1).replaceAll("\\\\", "/"),
    fileID: first.fileID,
    status: "indexed",
    hash: "deadbeef",
    language: "typescript",
    sizeBytes: first.sizeBytes,
    mtimeMs: first.mtimeMs,
    lineCount: 1,
    fileCode: "",
    nodes: [],
    edges: [],
    backend: "regex",
    timings: { readMs: 0, hashMs: 0, parseMs: 0 },
  })
}
${
  behaviour === "malformed"
    ? 'process.stdout.write("{ this is not json\\n")'
    : behaviour === "crash"
      ? "process.exit(7)"
      : behaviour === "short"
        ? 'emit({ type: "summary", mode: "files", version: "fake", files: 0, indexed: 0, skipped: 0, parseErrors: 0, skippedByReason: { gitignored: 0, banyanignored: 0, artifact: 0, tooLarge: 0, minified: 0, tooLargeParse: 0, cached: 0, readError: 0, parseFailure: 0 }, timings: { walkMs: 0, readMs: 0, hashMs: 0, parseMs: 0, totalMs: 0 }, workers: 1 })'
        : 'process.stdout.write("{ not json\\n")'
}
`
  await writeFile(script, body, "utf8")
  const built = await Bun.build({
    entrypoints: [script],
    compile: { outfile: exe },
    minify: false,
  })
  if (!built.success) throw new Error(`failed to compile fake sidecar: ${built.logs.map(String).join("\n")}`)
  return exe
}

const seed = async (root: string) => {
  await mkdir(join(root, "src"), { recursive: true })
  await writeFile(join(root, "src/a.ts"), "export function alpha() {\n  return beta()\n}\n")
  await writeFile(join(root, "src/b.ts"), "export function beta() {\n  return 1\n}\n")
  await writeFile(join(root, "src/c.ts"), "export function gamma() {\n  return alpha()\n}\n")
}

interface Run {
  backend: string
  indexed: number
  nodes: string[]
}

const indexWith = async (root: string, executable: string | undefined): Promise<Run> => {
  const dbDir = await makeTemp("banyan-fallback-db-")
  const previous = process.env.BANYANCODE_NATIVE_INDEXER_PATH
  if (executable === undefined) delete process.env.BANYANCODE_NATIVE_INDEXER_PATH
  else process.env.BANYANCODE_NATIVE_INDEXER_PATH = executable
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* Storage.open({
            projectRoot: root,
            env: { ...process.env, BANYANCODE_PROJECT_DB_DIR: dbDir },
          })
          const repo = makeRepo(storage)
          const indexer = yield* makeIndexer(repo, storage)
          const result = yield* indexer.index({ root, force: true })
          const nodes = yield* repo.listAllNodes()
          return {
            backend: result.backend,
            indexed: result.indexed,
            nodes: nodes.map((node) => `${node.kind}:${node.name}:${node.startLine}`).sort(),
          }
        }),
      ),
    )
  } finally {
    if (previous === undefined) delete process.env.BANYANCODE_NATIVE_INDEXER_PATH
    else process.env.BANYANCODE_NATIVE_INDEXER_PATH = previous
  }
}

describe("native indexer fallback", () => {
  test("a missing binary still indexes everything on the TypeScript parser", async () => {
    const root = await makeTemp("banyan-fallback-tree-")
    await seed(root)
    const run = await indexWith(root, join(root, "definitely-not-here"))
    expect(run.backend).toBe("typescript")
    expect(run.indexed).toBe(3)
    expect(run.nodes).toContain("function:alpha:1")
  }, 120_000)

  test("a malformed NDJSON line mid-stream does not kill the build", async () => {
    const root = await makeTemp("banyan-fallback-tree-")
    await seed(root)
    const exe = await buildFakeSidecar("malformed")
    const run = await indexWith(root, exe)
    // The fake delivered one file and then garbage: the build must finish with
    // all three files indexed and the backend recorded as the fallback.
    expect(run.backend).toBe("typescript")
    expect(run.indexed).toBe(3)
    // The fake delivered the first requested file with no symbol nodes and the other two
    // were re-indexed by the TypeScript parser. Which file comes first follows the walk
    // order, which differs between Windows and Linux.
    expect(run.nodes.filter((node) => node.startsWith("file:"))).toEqual(["file:a.ts:1", "file:b.ts:1", "file:c.ts:1"])
    expect(run.nodes.filter((node) => node.startsWith("function:"))).toHaveLength(2)
  }, 180_000)

  test("a crash mid-stream does not kill the build", async () => {
    const root = await makeTemp("banyan-fallback-tree-")
    await seed(root)
    const exe = await buildFakeSidecar("crash")
    const run = await indexWith(root, exe)
    expect(run.backend).toBe("typescript")
    expect(run.indexed).toBe(3)
  }, 180_000)

  test("a protocol version mismatch falls back instead of trusting the stream", async () => {
    const root = await makeTemp("banyan-fallback-tree-")
    await seed(root)
    const exe = await buildFakeSidecar("bad-protocol")
    const run = await indexWith(root, exe)
    expect(run.backend).toBe("typescript")
    expect(run.indexed).toBe(3)
  }, 180_000)

  test("a sidecar that delivers fewer files than asked still finishes", async () => {
    const root = await makeTemp("banyan-fallback-tree-")
    await seed(root)
    const exe = await buildFakeSidecar("short")
    const run = await indexWith(root, exe)
    expect(run.backend).toBe("typescript")
    expect(run.indexed).toBe(3)
  }, 180_000)
})

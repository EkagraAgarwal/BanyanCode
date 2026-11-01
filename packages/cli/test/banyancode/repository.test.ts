import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { cli, fakeServer, rpcOutput, startServer, tinyProject, tmpRoot, type RunningServer } from "./fixture"

let root: string
let project: string
let server: RunningServer

beforeAll(async () => {
  root = await tmpRoot("banyancode-cli-repository-")
  project = await tinyProject(root)
  server = await startServer(root)
  const build = await cli(root, ["codegraph", "build", "--root", project, "--timeout", "120", "--server", server.url])
  if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr}`)
}, 240_000)

afterAll(async () => {
  await server?.stop()
  if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {})
})

const sliceFields = [
  "entrypoints=",
  "symbols=",
  "tests=",
  "docs=",
  "configs=",
  "routes=",
]

describe("repository commands against a real server", () => {
  test("query prints v1's context summary and symbol list", async () => {
    const result = await cli(root, ["repository", "query", "hello", "--server", server.url])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("Repository query: hello")
    expect(result.stderr).toMatch(/symbols=\d+ tests=\d+ docs=\d+ configs=\d+/)
    expect(result.stderr).toMatch(/graph: \d+ nodes, \d+ edges/)
    expect(result.stderr).toMatch(/commits: \d+/)
  }, 120_000)

  test("explain prints the slice summary and important symbols", async () => {
    const result = await cli(root, ["repository", "explain", "hello", "--server", server.url])
    expect(result.exitCode).toBe(0)
    for (const field of sliceFields) expect(result.stderr).toContain(field)
    expect(result.stderr).toContain("Important symbols:")
    expect(result.stderr).toContain("hello")
  }, 120_000)

  test("trace walks downstream entrypoints", async () => {
    const result = await cli(root, ["repository", "trace", "hello", "--depth", "3", "--server", server.url])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("Downstream entrypoints:")
  }, 120_000)

  test("impact names direct dependents", async () => {
    const result = await cli(root, ["repository", "impact", "src/greeter.ts", "--server", server.url])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("Direct dependents:")
  }, 120_000)

  test("tests lists tests that reference the symbol", async () => {
    const result = await cli(root, ["repository", "tests", "hello", "--server", server.url])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("Tests referencing hello")
  }, 120_000)

  test("ownership reports the most active author", async () => {
    const result = await cli(root, ["repository", "ownership", "src/greeter.ts", "--server", server.url])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toMatch(/(no owner|\S+) \(\d+ commits\)/)
  }, 120_000)

  test("relationships prints related nodes from a nodeID", async () => {
    const fake = fakeServer((_request, url) => {
      if (url.pathname === "/api/rpc/banyancode.intel/relationships")
        return rpcOutput([
          {
            id: "n1",
            fileID: "f1",
            kind: "function",
            name: "hello",
            signature: "hello(name: string)",
            startLine: 1,
            endLine: 3,
          },
        ])
      return undefined
    })
    try {
      const result = await cli(root, ["repository", "relationships", "n1", "--depth", "2", "--server", fake.url])
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain("Related nodes")
      expect(result.stderr).toContain("hello")
    } finally {
      fake.stop()
    }
  }, 180_000)
})

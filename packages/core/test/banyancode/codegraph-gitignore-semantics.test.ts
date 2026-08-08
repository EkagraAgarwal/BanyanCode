import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"

process.env.BANYANCODE_ENABLE = "1"

describe("CodegraphIndexer gitignore semantics", () => {
  const runIndex = async (root: string) => {
    const dbPath = path.join(root, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )
    return Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service
        const result = yield* indexer.index({ root })
        const paths = (yield* repo.listAllFiles()).map((f) => f.path.replaceAll("\\", "/"))
        return { result, paths }
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  }

  test("** slash pattern prunes dirs at any depth", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path
    await fs.writeFile(path.join(root, ".gitignore"), "**/.bun-cache/\n")
    await fs.mkdir(path.join(root, "src"), { recursive: true })
    await fs.writeFile(path.join(root, "src", "main.ts"), "export const main = 1\n")
    await fs.mkdir(path.join(root, "src", ".bun-cache"), { recursive: true })
    await fs.writeFile(path.join(root, "src", ".bun-cache", "dep.ts"), "export const dep = 1\n")
    await fs.mkdir(path.join(root, ".bun-cache"), { recursive: true })
    await fs.writeFile(path.join(root, ".bun-cache", "dep2.ts"), "export const dep2 = 1\n")

    const { result, paths } = await runIndex(root)
    expect(result.indexed).toBe(1)
    expect(result.skippedByReason.gitignored).toBe(2)
    expect(paths.some((p) => p.endsWith("src/main.ts"))).toBe(true)
    expect(paths.some((p) => p.includes(".bun-cache"))).toBe(false)
  })

  test("! negation re-includes a later pattern (last match wins)", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path
    await fs.writeFile(path.join(root, ".gitignore"), "*.ts\n!keep.ts\n")
    await fs.writeFile(path.join(root, "a.ts"), "export const a = 1\n")
    await fs.writeFile(path.join(root, "keep.ts"), "export const keep = 1\n")

    const { result, paths } = await runIndex(root)
    expect(result.indexed).toBe(1)
    expect(result.skippedByReason.gitignored).toBe(1)
    expect(paths.some((p) => p.endsWith("keep.ts"))).toBe(true)
    expect(paths.some((p) => p.endsWith("a.ts"))).toBe(false)
  })

  test("nested .gitignore applies to its subtree only", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path
    await fs.mkdir(path.join(root, "sub"), { recursive: true })
    await fs.writeFile(path.join(root, "sub", ".gitignore"), "*.ts\n")
    await fs.writeFile(path.join(root, "sub", "a.ts"), "export const a = 1\n")
    await fs.writeFile(path.join(root, "root.ts"), "export const root = 1\n")

    const { result, paths } = await runIndex(root)
    expect(result.indexed).toBe(1)
    expect(result.skippedByReason.gitignored).toBe(1)
    expect(paths.some((p) => p.endsWith("root.ts"))).toBe(true)
    expect(paths.some((p) => p.endsWith("sub/a.ts"))).toBe(false)
  })

  test("nested negation overrides an ancestor pattern", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path
    await fs.writeFile(path.join(root, ".gitignore"), "*.ts\n")
    await fs.mkdir(path.join(root, "sub"), { recursive: true })
    await fs.writeFile(path.join(root, "sub", ".gitignore"), "!keep.ts\n")
    await fs.writeFile(path.join(root, "x.ts"), "export const x = 1\n")
    await fs.writeFile(path.join(root, "sub", "keep.ts"), "export const keep = 1\n")
    await fs.writeFile(path.join(root, "sub", "other.ts"), "export const other = 1\n")

    const { result, paths } = await runIndex(root)
    expect(result.indexed).toBe(1)
    expect(result.skippedByReason.gitignored).toBe(2)
    expect(paths.some((p) => p.endsWith("sub/keep.ts"))).toBe(true)
    expect(paths.some((p) => p.endsWith("x.ts"))).toBe(false)
    expect(paths.some((p) => p.endsWith("sub/other.ts"))).toBe(false)
  })

  test("nested `*` ignore (husky-style) skips a dir's contents but not siblings", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path
    await fs.mkdir(path.join(root, "hooks", "_"), { recursive: true })
    await fs.writeFile(path.join(root, "hooks", "_", ".gitignore"), "*\n")
    await fs.writeFile(path.join(root, "hooks", "_", "pre-push"), "#!/bin/sh\necho hi\n")
    await fs.writeFile(path.join(root, "hooks", "helper.ts"), "export const helper = 1\n")

    const { result, paths } = await runIndex(root)
    expect(result.indexed).toBe(1)
    // `*` matches both hooks/_/pre-push and hooks/_/.gitignore itself (git
    // semantics: a .gitignore's own patterns can ignore the file).
    expect(result.skippedByReason.gitignored).toBe(2)
    expect(paths.some((p) => p.endsWith("hooks/helper.ts"))).toBe(true)
    expect(paths.some((p) => p.includes("hooks/_"))).toBe(false)
  })

  test("directory-only trailing slash pattern prunes the subtree", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path
    await fs.writeFile(path.join(root, ".gitignore"), "vendor/\n")
    await fs.mkdir(path.join(root, "vendor"), { recursive: true })
    await fs.writeFile(path.join(root, "vendor", "lib.ts"), "export const lib = 1\n")
    await fs.writeFile(path.join(root, "main.ts"), "export const main = 1\n")

    const { result, paths } = await runIndex(root)
    expect(result.indexed).toBe(1)
    expect(result.skippedByReason.gitignored).toBe(1)
    expect(paths.some((p) => p.endsWith("main.ts"))).toBe(true)
    expect(paths.some((p) => p.includes("vendor"))).toBe(false)
  })
})

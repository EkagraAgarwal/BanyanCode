import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import {
  channelSuffix,
  classifyName,
  formatBytes,
  projectsDirectory,
  readIndexedRoot,
  shortHash,
} from "../../src/commands/handlers/banyancode/db-gc"
import { cli, envFor, tmpRoot } from "./fixture"

const createDb = (file: string, indexedRoot?: string) => {
  const db = new Database(file, { create: true })
  db.exec(
    "CREATE TABLE IF NOT EXISTS codegraph_meta (id text PRIMARY KEY, indexed_root text);",
  )
  if (indexedRoot !== undefined) db.prepare("INSERT INTO codegraph_meta (id, indexed_root) VALUES (?, ?)").run("m", indexedRoot)
  db.close()
}

describe("db gc classification", () => {
  test("formats byte counts like v1", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB")
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.0 GB")
  })

  test("protects the current worktree in every channel and never touches foreign files", () => {
    const tag = shortHash(path.resolve("."))
    expect(classifyName(`banyancode-${tag}.db`, tag, undefined, "")).toBe("current")
    expect(classifyName(`banyancode-${tag}-dev.db`, tag, undefined, "-dev")).toBe("current")
    expect(classifyName(`banyancode-${tag}-dev.db`, tag, undefined, "")).toBe("other-channel-current")
    expect(classifyName("other.db", tag, undefined, "")).toBe("foreign")
    expect(classifyName(`banyancode-${"0".repeat(12)}.db`, tag, undefined, "")).toBe("unknown")
  })

  test("honors the project DB dir override", () => {
    const previous = process.env.BANYANCODE_PROJECT_DB_DIR
    process.env.BANYANCODE_PROJECT_DB_DIR = path.join("tmp", "projects")
    try {
      expect(projectsDirectory()).toBe(path.join("tmp", "projects"))
    } finally {
      if (previous === undefined) delete process.env.BANYANCODE_PROJECT_DB_DIR
      else process.env.BANYANCODE_PROJECT_DB_DIR = previous
    }
  })
})

describe("db gc command", () => {
  test("lists every family, deletes only orphans with --yes, and is a dry run by default", async () => {
    const root = await tmpRoot("banyancode-cli-gc-")
    const projects = path.join(root, "projects")
    await fs.mkdir(projects, { recursive: true })

    const currentRoot = path.join(root, "current-project")
    const liveRoot = path.join(root, "live-project")
    const goneRoot = path.join(root, "gone-project")
    await fs.mkdir(currentRoot, { recursive: true })
    await fs.mkdir(liveRoot, { recursive: true })

    const currentName = `banyancode-${shortHash(currentRoot)}${channelSuffix()}.db`
    const liveName = `banyancode-${shortHash(liveRoot)}.db`
    const orphanName = `banyancode-${shortHash(goneRoot)}.db`
    createDb(path.join(projects, currentName))
    createDb(path.join(projects, liveName), liveRoot)
    createDb(path.join(projects, orphanName), goneRoot)
    await fs.writeFile(path.join(projects, "unrelated.db"), "")
    expect(await readIndexedRoot(path.join(projects, orphanName))).toBe(goneRoot)

    const env = { BANYANCODE_PROJECT_DB_DIR: projects }
    const dry = await cli(root, ["db", "gc", "--root", currentRoot], { env })
    expect(dry.exitCode).toBe(0)
    expect(dry.stderr).toContain(`Databases in ${projects}`)
    expect(dry.stderr).toContain(`${currentName}  `)
    expect(dry.stderr).toContain("[current]")
    expect(dry.stderr).toContain("[live project (kept)]")
    expect(dry.stderr).toContain("[orphan]")
    expect(dry.stderr).toContain("[foreign (never deleted)]")
    expect(dry.stderr).toContain("Orphan candidates: 1 file(s)")
    expect(dry.stderr).toContain("Dry run: nothing deleted.")
    expect(await fs.stat(path.join(projects, orphanName))).toBeTruthy()

    const forcedDryRun = await cli(root, ["db", "gc", "--yes", "--dry-run", "--root", currentRoot], { env })
    expect(forcedDryRun.stderr).toContain("Dry run: nothing deleted.")
    expect(await fs.stat(path.join(projects, orphanName))).toBeTruthy()

    const applied = await cli(root, ["db", "gc", "--yes", "--root", currentRoot], { env })
    expect(applied.exitCode).toBe(0)
    expect(applied.stderr).toContain("Deleted 1 file(s)")
    await expect(fs.stat(path.join(projects, orphanName))).rejects.toThrow()
    expect(await fs.stat(path.join(projects, currentName))).toBeTruthy()
    expect(await fs.stat(path.join(projects, liveName))).toBeTruthy()
    expect(await fs.stat(path.join(projects, "unrelated.db"))).toBeTruthy()
  }, 180_000)

  test("reports a missing projects directory without failing", async () => {
    const root = await tmpRoot("banyancode-cli-gc-empty-")
    const result = await cli(root, ["db", "gc"], {
      env: { BANYANCODE_PROJECT_DB_DIR: path.join(root, "does-not-exist") },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("nothing to collect")
  }, 120_000)
})

test("envFor points the project DB dir into the isolated root", async () => {
  const root = await tmpRoot("banyancode-cli-env-")
  expect((envFor(root) as Record<string, unknown>).BANYANCODE_PROJECT_DB_DIR).toBe(path.join(root, "projects"))
})

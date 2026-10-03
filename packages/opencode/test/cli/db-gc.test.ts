import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { sanitizeRoot, shortHash } from "@opencode-ai/core/database/banyan-db-path"
import yargs from "yargs"
import {
  DbGcCommand,
  deleteOrphans,
  orphanBytes,
  orphanFamilies,
  runDbGc,
  scanBanyanDir,
  staleDbHint,
  STALE_DB_HINT_THRESHOLD_BYTES,
} from "../../src/cli/cmd/db-gc"
import { tmpdir } from "../fixture/fixture"

const tagFor = (root: string) => shortHash(sanitizeRoot(root))

async function seed(dir: string, files: Record<string, string | Buffer>) {
  await fs.mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content)
  }
}

describe("db gc classification", () => {
  test("current tag is current, suffixed current tag is protected, others are orphan", async () => {
    await using tmp = await tmpdir()
    const tag = tagFor(tmp.path)
    const other = tag === "aaaaaaaaaaaaaaaa" ? "bbbbbbbbbbbb" : "aaaaaaaaaaaaaaaa"
    const banyanDir = path.join(tmp.path, ".banyancode")
    await seed(banyanDir, {
      [`banyancode-${tag}.db`]: "current",
      [`banyancode-${tag}-dev.db`]: "other-channel",
      [`banyancode-${tag}-main.db`]: "other-channel",
      [`banyancode-${other}.db`]: "orphan-tag",
      "banyancode-mesh-phase0-complete.db": "orphan-branch",
      "banyancode-main.db": "orphan-legacy",
      "unrelated.db": "foreign",
    })

    const listing = scanBanyanDir(banyanDir, tmp.path)
    const byName = new Map(listing.families.map((f) => [f.name, f.classification]))
    expect(byName.get(`banyancode-${tag}.db`)).toBe("current")
    expect(byName.get(`banyancode-${tag}-dev.db`)).toBe("other-channel-current")
    expect(byName.get(`banyancode-${tag}-main.db`)).toBe("other-channel-current")
    expect(byName.get(`banyancode-${other}.db`)).toBe("orphan")
    expect(byName.get("banyancode-mesh-phase0-complete.db")).toBe("orphan")
    expect(byName.get("banyancode-main.db")).toBe("orphan")
    expect(byName.get("unrelated.db")).toBe("foreign")

    expect(orphanFamilies(listing).map((f) => f.name).sort()).toEqual(
      [`banyancode-${other}.db`, "banyancode-main.db", "banyancode-mesh-phase0-complete.db"].sort(),
    )
  })

  test("sizes include -wal/-shm siblings", async () => {
    await using tmp = await tmpdir()
    const tag = tagFor(tmp.path)
    const banyanDir = path.join(tmp.path, ".banyancode")
    await seed(banyanDir, {
      "banyancode-deadbeefcafe.db": Buffer.alloc(100, 1),
      "banyancode-deadbeefcafe.db-wal": Buffer.alloc(50, 2),
      "banyancode-deadbeefcafe.db-shm": Buffer.alloc(25, 3),
      [`banyancode-${tag}.db`]: Buffer.alloc(10, 4),
    })

    const listing = scanBanyanDir(banyanDir, tmp.path)
    const orphan = listing.families.find((f) => f.name === "banyancode-deadbeefcafe.db")
    expect(orphan?.bytes).toBe(175)
    expect(orphanBytes(listing)).toBe(175)
  })
})

describe("db gc deletion", () => {
  test("deletes only orphans plus their -wal/-shm siblings and reports reclaimed bytes", async () => {
    await using tmp = await tmpdir()
    const tag = tagFor(tmp.path)
    const banyanDir = path.join(tmp.path, ".banyancode")
    await seed(banyanDir, {
      [`banyancode-${tag}.db`]: Buffer.alloc(100, 1),
      [`banyancode-${tag}-dev.db`]: Buffer.alloc(200, 2),
      "banyancode-sync-upstream-providers.db": Buffer.alloc(300, 3),
      "banyancode-sync-upstream-providers.db-wal": Buffer.alloc(40, 4),
      "unrelated.db": Buffer.alloc(500, 5),
    })

    const listing = scanBanyanDir(banyanDir, tmp.path)
    const { deleted, reclaimedBytes } = deleteOrphans(banyanDir, orphanFamilies(listing))

    expect(deleted.sort()).toEqual(
      ["banyancode-sync-upstream-providers.db", "banyancode-sync-upstream-providers.db-wal"].sort(),
    )
    expect(reclaimedBytes).toBe(340)

    const remaining = await fs.readdir(banyanDir)
    expect(remaining.sort()).toEqual(
      [`banyancode-${tag}.db`, `banyancode-${tag}-dev.db`, "unrelated.db"].sort(),
    )
  })
})

describe("stale db hint", () => {
  test("no hint when orphans are small", async () => {
    await using tmp = await tmpdir()
    await seed(path.join(tmp.path, ".banyancode"), { "banyancode-main.db": "small" })
    expect(staleDbHint(tmp.path)).toBeUndefined()
  })

  test("no hint without a .banyancode directory", async () => {
    await using tmp = await tmpdir()
    expect(staleDbHint(path.join(tmp.path, "nope"))).toBeUndefined()
  })

  test("hint when orphans exceed 500 MB (sparse file, stat-only)", async () => {
    await using tmp = await tmpdir()
    const banyanDir = path.join(tmp.path, ".banyancode")
    await fs.mkdir(banyanDir, { recursive: true })
    const handle = await fs.open(path.join(banyanDir, "banyancode-main.db"), "w")
    await handle.truncate(STALE_DB_HINT_THRESHOLD_BYTES + 1024)
    await handle.close()
    const hint = staleDbHint(tmp.path)
    expect(hint).toContain("banyancode db gc")
  })
})

describe("db gc flags", () => {
  const files = (tag: string) => ({
    [`banyancode-${tag}.db`]: Buffer.alloc(10, 1),
    [`banyancode-${tag}-dev.db`]: Buffer.alloc(10, 2),
    "banyancode-deadbeefcafe.db": Buffer.alloc(100, 3),
    "banyancode-deadbeefcafe.db-wal": Buffer.alloc(50, 4),
  })
  const run = async (flags: { yes?: boolean; dryRun?: boolean }) => {
    await using tmp = await tmpdir()
    const tag = tagFor(tmp.path)
    const banyanDir = path.join(tmp.path, ".banyancode")
    await seed(banyanDir, files(tag))
    runDbGc({ yes: flags.yes ?? false, dryRun: flags.dryRun, root: tmp.path })
    return { remaining: (await fs.readdir(banyanDir)).sort(), tag }
  }

  test("--yes alone deletes orphans and keeps current-worktree databases", async () => {
    const { remaining, tag } = await run({ yes: true })
    expect(remaining).toEqual([`banyancode-${tag}-dev.db`, `banyancode-${tag}.db`].sort())
  })

  test("no flags deletes nothing", async () => {
    expect((await run({})).remaining).toHaveLength(4)
  })

  test("--yes --dry-run deletes nothing", async () => {
    expect((await run({ yes: true, dryRun: true })).remaining).toHaveLength(4)
  })

  test("--yes leaves dry-run unset when parsed by the command builder", async () => {
    if (typeof DbGcCommand.builder !== "function") throw new Error("expected a builder function")
    const parsed = (await DbGcCommand.builder(yargs([]))).parseSync(["--yes"])
    expect(parsed.yes).toBe(true)
    expect(parsed["dry-run"]).toBeUndefined()
  })
})

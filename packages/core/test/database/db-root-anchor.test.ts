import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { deriveBanyanDbPath } from "@opencode-ai/core/database/banyan-db-path"
import { tmpdir } from "../fixture/tmpdir"

const cwd = process.cwd()
const override = process.env.BANYANCODE_PROJECT_DB_DIR

afterEach(() => {
  process.chdir(cwd)
  if (override === undefined) delete process.env.BANYANCODE_PROJECT_DB_DIR
  else process.env.BANYANCODE_PROJECT_DB_DIR = override
})

describe("Database.path() repo-root anchoring", () => {
  test("a monorepo subfolder resolves to the same DB as the repo root, even with a stale marker in the subfolder", async () => {
    await using tmp = await tmpdir()
    delete process.env.BANYANCODE_PROJECT_DB_DIR
    const root = realpathSync(tmp.path)
    const sub = join(root, "packages", "app")
    mkdirSync(join(root, ".git"), { recursive: true })
    mkdirSync(join(root, ".banyancode"), { recursive: true })
    mkdirSync(join(sub, ".banyancode"), { recursive: true })
    writeFileSync(join(sub, "package.json"), "{}")

    process.chdir(root)
    const fromRoot = Database.path()
    process.chdir(sub)
    const fromSub = Database.path()
    process.chdir(cwd)

    expect(fromSub).toBe(fromRoot)
    expect(fromSub).toBe(deriveBanyanDbPath(join(root, ".banyancode"), root).dbPath)
  })
})

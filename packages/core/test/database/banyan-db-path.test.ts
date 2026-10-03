import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { deriveBanyanDbPath } from "@opencode-ai/core/database/banyan-db-path"

const OVERRIDE_KEY = "BANYANCODE_PROJECT_DB_DIR"

afterEach(() => {
  delete process.env[OVERRIDE_KEY]
})

describe("deriveBanyanDbPath project-dir override", () => {
  test("without override, db lives in the given banyanDir", () => {
    const derived = deriveBanyanDbPath(join("D:", "repo", ".banyancode"), join("D:", "repo"))
    expect(derived.dbPath).toBe(join("D:", "repo", ".banyancode", derived.filename))
    expect(derived.filename).toMatch(/^banyancode-[0-9a-f]{12}.*\.db$/)
  })

  test("with override, same filename is placed in the override dir", () => {
    const banyanDir = join("D:", "repo", ".banyancode")
    const root = join("D:", "repo")
    const baseline = deriveBanyanDbPath(banyanDir, root)

    const overrideDir = join("D:", "tmp", "project-dbs")
    process.env[OVERRIDE_KEY] = overrideDir
    const overridden = deriveBanyanDbPath(banyanDir, root)

    expect(overridden.filename).toBe(baseline.filename)
    expect(overridden.dbPath).toBe(join(overrideDir, baseline.filename))
  })

  test("empty override is ignored", () => {
    process.env[OVERRIDE_KEY] = "   "
    const banyanDir = join("D:", "repo", ".banyancode")
    const derived = deriveBanyanDbPath(banyanDir, join("D:", "repo"))
    expect(derived.dbPath).toBe(join(banyanDir, derived.filename))
  })
})

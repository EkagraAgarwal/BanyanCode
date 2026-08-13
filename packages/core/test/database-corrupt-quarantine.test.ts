import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "./fixture/tmpdir"

describe("Database corrupt-DB quarantine", () => {
  test("quarantines a malformed DB file and rebuilds a healthy database", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    fs.writeFileSync(dbPath, "this is not a sqlite database".repeat(100))

    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* db.get<{ n: number }>(sql`SELECT 1 as n`)
      }).pipe(Effect.provide(Database.layerFromPath(dbPath)), Effect.scoped),
    )

    // The rebuilt DB answers queries.
    expect(row).toEqual({ n: 1 })

    // The corrupt file was renamed aside; a fresh DB now lives at the path.
    const entries = fs.readdirSync(tmp.path)
    const quarantined = entries.filter((entry) => entry.includes(".corrupt-"))
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]).toMatch(/^test\.db\.corrupt-\d+$/)
    expect(entries).toContain("test.db")
  })

  test("healthy database is not quarantined", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "healthy.db")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.get<{ n: number }>(sql`SELECT 1 as n`)
      }).pipe(Effect.provide(Database.layerFromPath(dbPath)), Effect.scoped),
    )

    const entries = fs.readdirSync(tmp.path)
    expect(entries.some((entry) => entry.includes(".corrupt-"))).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode/core/database/drizzle"
import { DatabaseMigration } from "@opencode/core/database/migration"
import { Global } from "@opencode/util/global"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { tmpdir } from "./fixture/tmpdir"

const bootstrap = (data: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* DatabaseMigration.apply(db)
      yield* DatabaseMigration.apply(db)
      return yield* db.all<{ integration_id: string; label: string; value: string }>(
        sql`SELECT integration_id, label, value FROM credential ORDER BY integration_id`,
      )
    }).pipe(
      Effect.provideService(Global.Service, Global.make({ data })),
      Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    ),
  )

describe("database bootstrap", () => {
  test("a new database imports an existing auth.json", async () => {
    await using dir = await tmpdir()
    await Bun.write(
      path.join(dir.path, "auth.json"),
      JSON.stringify({ "opencode-go": { type: "api", key: "go-key" }, opencode: { type: "api", key: "zen-key" } }),
    )
    expect(await bootstrap(dir.path)).toEqual([
      { integration_id: "opencode", label: "API key", value: JSON.stringify({ type: "key", key: "zen-key" }) },
      { integration_id: "opencode-go", label: "API key", value: JSON.stringify({ type: "key", key: "go-key" }) },
    ])
  })

  test("no auth.json leaves no credentials", async () => {
    await using dir = await tmpdir()
    expect(await bootstrap(dir.path)).toEqual([])
  })

  test("a corrupt auth.json does not stop the database opening", async () => {
    await using dir = await tmpdir()
    await Bun.write(path.join(dir.path, "auth.json"), "not json {")
    expect(await bootstrap(dir.path)).toEqual([])
  })
})

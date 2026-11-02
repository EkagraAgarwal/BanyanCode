import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { openDatabase, query, run } from "../src/storage/driver.js"
import { acquireFileLock } from "../src/storage/lock.js"
import { applyMigrations, detectFtsTokenizer } from "../src/storage/migrate.js"
import { migrations } from "../src/storage/migrations.js"
import type { NativeDatabase } from "../src/storage/native.js"
import { resolveProjectDbPath } from "../src/storage/paths.js"
import { Storage } from "../src/storage/index.js"
import { Global } from "@opencode/util/global"

const withTemp = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-storage-"))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const insertNode = (db: NativeDatabase) => {
  run(db, "INSERT INTO codegraph_files (id, path, content_hash, language, indexed_at) VALUES (?, ?, ?, ?, ?)", [
    "file-1",
    "src/example.ts",
    "hash",
    "typescript",
    Date.now(),
  ])
  run(
    db,
    `INSERT INTO codegraph_nodes
      (id, file_id, kind, name, signature, start_line, end_line, code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["node-1", "file-1", "function", "BanyanCodegraphService", "build(): void", 1, 2, "export function build() {}"],
  )
  run(
    db,
    `INSERT INTO codegraph_nodes
      (id, file_id, kind, name, signature, start_line, end_line, code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["node-2", "file-1", "function", "unrelatedSymbol", "other(): void", 4, 5, "export function other() {}"],
  )
}

describe("banyancode storage", () => {
  test("project db path is <data>/projects/banyancode-<12 hex>.db, outside the project", async () => {
    await withTemp(async (directory) => {
      const resolved = resolveProjectDbPath({ projectRoot: directory, env: {} })
      expect(resolved.filename).toMatch(/^banyancode-[a-f0-9]{12}\.db$/)
      expect(resolved.directory).toBe(join(Global.Path.data, "projects"))
      expect(resolved.dbPath.startsWith(resolved.root)).toBe(false)
      expect(resolved.dbPath).toBe(join(resolved.directory, resolved.filename))
    })
  })

  test("BANYANCODE_PROJECT_DB_DIR overrides the directory and keeps the hashed filename", async () => {
    await withTemp(async (directory) => {
      const resolved = resolveProjectDbPath({ projectRoot: directory, env: { BANYANCODE_PROJECT_DB_DIR: directory } })
      expect(resolved.directory).toBe(directory)
      expect(resolved.filename).toMatch(/^banyancode-[a-f0-9]{12}\.db$/)
    })
  })

  test("non-stable channels add a db suffix; latest/beta/prod and the override do not", async () => {
    await withTemp(async (directory) => {
      const latest = resolveProjectDbPath({ projectRoot: directory, env: {}, channel: "latest" })
      expect(latest.filename).toMatch(/^banyancode-[a-f0-9]{12}\.db$/)
      expect(latest.channelSuffix).toBe("")

      const dev = resolveProjectDbPath({ projectRoot: directory, env: {}, channel: "dev" })
      expect(dev.filename).toMatch(/^banyancode-[a-f0-9]{12}-dev\.db$/)
      expect(dev.channelSuffix).toBe("-dev")

      const next = resolveProjectDbPath({ projectRoot: directory, env: {}, channel: "26.08.11-dev.abc1234" })
      expect(next.filename).toMatch(/^banyancode-[a-f0-9]{12}-26\.08\.11-dev\.abc1234\.db$/)

      const sanitized = resolveProjectDbPath({ projectRoot: directory, env: {}, channel: "dev/local" })
      expect(sanitized.filename.endsWith("-dev-local.db")).toBe(true)

      const disabled = resolveProjectDbPath({
        projectRoot: directory,
        env: { BANYANCODE_DISABLE_CHANNEL_DB: "1" },
        channel: "dev",
      })
      expect(disabled.filename).toMatch(/^banyancode-[a-f0-9]{12}\.db$/)
    })
  })

  test("Storage.open accepts a channel and opens the suffixed path", async () => {
    await withTemp(async (directory) => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Storage.open({
              projectRoot: directory,
              env: { BANYANCODE_PROJECT_DB_DIR: directory },
              channel: "dev",
            })
            return storage.path
          }),
        ),
      )
      expect(result.endsWith("-dev.db")).toBe(true)
    })
  })

  test("migrations apply once and are idempotent", async () => {
    await withTemp(async (directory) => {
      const resolved = resolveProjectDbPath({ projectRoot: directory, env: { BANYANCODE_PROJECT_DB_DIR: directory } })
      const db = await openDatabase(resolved.dbPath)
      try {
        const first = applyMigrations(db)
        expect(first.applied).toEqual(migrations.map((migration) => migration.id))
        expect(first.version).toBe(migrations.length)

        const second = applyMigrations(db)
        expect(second.applied).toEqual([])
        expect(second.version).toBe(first.version)

        const recorded = query<{ count: number }>(db, "SELECT COUNT(*) AS count FROM banyancode_migrations")
        expect(recorded[0]?.count).toBe(migrations.length)
        expect(query<{ journal_mode: string }>(db, "PRAGMA journal_mode")[0]?.journal_mode).toBe("wal")

        const tables = new Set(
          query<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").map(
            (row) => row.name,
          ),
        )
        for (const table of [
          "codegraph_files",
          "codegraph_nodes",
          "codegraph_edges",
          "codegraph_meta",
          "codegraph_parse_errors",
          "codegraph_tool_usage",
          "codegraph_service_tags",
          "codegraph_traces",
          "codegraph_nodes_fts",
          "verification_runs",
          "subagent_messages",
          "subagent_plans",
          "subagent_review_requests",
          "banyancode_migrations",
        ]) {
          expect(tables.has(table)).toBe(true)
        }
        expect(detectFtsTokenizer(db)).toBe("trigram")
      } finally {
        db.close()
      }
    })
  })

  test("codegraph_nodes_fts trigram matches substrings and follows triggers", async () => {
    await withTemp(async (directory) => {
      const resolved = resolveProjectDbPath({ projectRoot: directory, env: { BANYANCODE_PROJECT_DB_DIR: directory } })
      const db = await openDatabase(resolved.dbPath)
      try {
        applyMigrations(db)
        insertNode(db)

        const hits = query<{ name: string }>(
          db,
          "SELECT name FROM codegraph_nodes_fts WHERE codegraph_nodes_fts MATCH ?",
          ["anyan"],
        )
        expect(hits.map((row) => row.name)).toEqual(["BanyanCodegraphService"])

        run(db, "UPDATE codegraph_nodes SET name = ? WHERE id = ?", ["RenamedService", "node-1"])
        expect(
          query(db, "SELECT name FROM codegraph_nodes_fts WHERE codegraph_nodes_fts MATCH ?", ["anyan"]),
        ).toHaveLength(0)
        expect(
          query<{ name: string }>(db, "SELECT name FROM codegraph_nodes_fts WHERE codegraph_nodes_fts MATCH ?", [
            "Renamed",
          ]),
        ).toEqual([{ name: "RenamedService" }])

        run(db, "DELETE FROM codegraph_nodes WHERE id = ?", ["node-1"])
        expect(
          query(db, "SELECT name FROM codegraph_nodes_fts WHERE codegraph_nodes_fts MATCH ?", ["Renamed"]),
        ).toHaveLength(0)
      } finally {
        db.close()
      }
    })
  })

  test("file lock excludes a second writer and releases", async () => {
    await withTemp(async (directory) => {
      const lockPath = join(directory, "write.lock")
      const first = await acquireFileLock(lockPath)
      await expect(acquireFileLock(lockPath, { timeoutMs: 30, retryMs: 5 })).rejects.toThrow(/Timed out/)
      await first.release()
      const second = await acquireFileLock(lockPath)
      await second.release()
    })
  })

  test("a corrupt project database is moved aside and replaced with a working one", async () => {
    await withTemp(async (directory) => {
      const resolved = resolveProjectDbPath({ projectRoot: directory, env: { BANYANCODE_PROJECT_DB_DIR: directory } })
      const garbage = "this is definitely not a sqlite database file 0123456789".repeat(8)
      await writeFile(resolved.dbPath, garbage)
      await writeFile(`${resolved.dbPath}-wal`, garbage)

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Storage.open({ projectRoot: directory, env: { BANYANCODE_PROJECT_DB_DIR: directory } })
            const rows = yield* storage.query<{ count: number }>("SELECT COUNT(*) AS count FROM banyancode_migrations")
            return { path: storage.path, version: storage.schemaVersion, count: rows[0]?.count }
          }),
        ),
      )
      expect(result.version).toBe(migrations.length)
      expect(result.count).toBe(migrations.length)
      expect(existsSync(resolved.dbPath)).toBe(true)

      const names = await readdir(directory)
      const corrupt = names.filter((name) => name.includes("-corrupt-"))
      expect(corrupt.length).toBeGreaterThan(0)
      const kept = corrupt.find((name) => name.includes(".db-corrupt-"))
      expect(kept).toBeDefined()
      expect((await readFile(join(directory, kept!))).toString()).toBe(garbage)
    })
  })

  test("a non-corruption open failure still fails without moving the file", async () => {
    await withTemp(async (directory) => {
      const resolved = resolveProjectDbPath({ projectRoot: directory, env: { BANYANCODE_PROJECT_DB_DIR: directory } })
      // A directory at the database path is an open failure SQLite reports
      // differently from corruption; recovery must not rename it.
      await mkdir(resolved.dbPath, { recursive: true })

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Storage.open({ projectRoot: directory, env: { BANYANCODE_PROJECT_DB_DIR: directory } }),
        ),
      )
      expect(exit._tag).toBe("Failure")
      expect(existsSync(resolved.dbPath)).toBe(true)
      expect((await readdir(directory)).some((name) => name.includes("-corrupt-"))).toBe(false)
    })
  })

  test("Effect storage service opens, migrates and closes in scope", async () => {
    await withTemp(async (directory) => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Storage.open({ projectRoot: directory, env: { BANYANCODE_PROJECT_DB_DIR: directory } })
            const rows = yield* storage.query<{ count: number }>("SELECT COUNT(*) AS count FROM banyancode_migrations")
            return { path: storage.path, version: storage.schemaVersion, count: rows[0]?.count }
          }),
        ),
      )
      expect(result.version).toBe(migrations.length)
      expect(result.count).toBe(migrations.length)
      expect(result.path.endsWith(".db")).toBe(true)
    })
  })
})

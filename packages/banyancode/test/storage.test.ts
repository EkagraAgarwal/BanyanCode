import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { openDatabase, query, run } from "../src/storage/driver.js"
import { acquireFileLock } from "../src/storage/lock.js"
import { applyMigrations, detectFtsTokenizer } from "../src/storage/migrate.js"
import { migrations } from "../src/storage/migrations.js"
import type { NativeDatabase } from "../src/storage/native.js"
import { resolveProjectDbPath } from "../src/storage/paths.js"
import { adoptFamily, adoptLegacyDatabase, Storage } from "../src/storage/index.js"
import { Global } from "@opencode/util/global"

const withTemp = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-storage-"))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const canonicalFor = (directory: string) =>
  resolveProjectDbPath({ projectRoot: directory, env: { BANYANCODE_PROJECT_DB_DIR: directory } })

/** Legacy per-channel name for a canonical filename (`banyancode-<hash>.db`). */
const legacyName = (filename: string, channel: string) => filename.replace(/\.db$/, `-${channel}.db`)

/** Renames a database family, sidecars included, the way a rebuild used to. */
const moveFamily = async (from: string, to: string) => {
  await rename(from, to)
  for (const sidecar of ["-wal", "-shm", "-journal"]) {
    await rename(`${from}${sidecar}`, `${to}${sidecar}`).catch(() => undefined)
  }
}

/** Read-only read, so a marker check never rewrites the file. */
const readMarkers = (file: string): string[] => {
  const db = new Database(file, { readonly: true })
  try {
    return (db.query("SELECT name FROM marker ORDER BY name").all() as ReadonlyArray<{ name: string }>).map(
      (row) => row.name,
    )
  } finally {
    db.close(true)
  }
}

const writeLegacy = async (file: string, markers: ReadonlyArray<string>) => {
  const db = await openDatabase(file)
  try {
    applyMigrations(db)
    run(db, "CREATE TABLE marker (name TEXT)")
    for (const marker of markers) run(db, "INSERT INTO marker (name) VALUES (?)", [marker])
    run(db, "PRAGMA wal_checkpoint(TRUNCATE)")
  } finally {
    db.close()
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

  test("every channel resolves to the same canonical database filename", async () => {
    await withTemp(async (directory) => {
      const plain = resolveProjectDbPath({ projectRoot: directory, env: {} })
      expect(plain.filename).toMatch(/^banyancode-[a-f0-9]{12}\.db$/)
      expect(plain.channelSuffix).toBe("")

      for (const channel of ["dev", "latest", "26.11.0-dev.abc1234", undefined]) {
        const resolved = resolveProjectDbPath({ projectRoot: directory, env: {}, channel })
        expect(resolved.filename).toBe(plain.filename)
        expect(resolved.dbPath).toBe(plain.dbPath)
        expect(resolved.channelSuffix).toBe("")
      }

      // The legacy per-channel opt-out no longer changes the filename either.
      const disabled = resolveProjectDbPath({
        projectRoot: directory,
        env: { BANYANCODE_DISABLE_CHANNEL_DB: "1" },
        channel: "dev",
      })
      expect(disabled.filename).toBe(plain.filename)
    })
  })

  test("Storage.open ignores the channel and opens the canonical path", async () => {
    await withTemp(async (directory) => {
      const resolved = canonicalFor(directory)
      const paths = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const stable = yield* Storage.open({ projectRoot: directory, env: { BANYANCODE_PROJECT_DB_DIR: directory } })
            const dev = yield* Storage.open({
              projectRoot: directory,
              env: { BANYANCODE_PROJECT_DB_DIR: directory },
              channel: "dev",
            })
            return [stable.path, dev.path]
          }),
        ),
      )
      expect(paths).toEqual([resolved.dbPath, resolved.dbPath])
    })
  })

  test("a legacy -dev database is adopted when the canonical database is missing", async () => {
    await withTemp(async (directory) => {
      const input = { projectRoot: directory, env: { BANYANCODE_PROJECT_DB_DIR: directory } }
      const resolved = canonicalFor(directory)
      const legacy = join(directory, legacyName(resolved.filename, "dev"))

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Storage.open(input)
            yield* storage.exec("CREATE TABLE marker (name TEXT)")
            yield* storage.exec("INSERT INTO marker (name) VALUES ('legacy-session')")
          }),
        ),
      )
      await moveFamily(resolved.dbPath, legacy)
      expect(existsSync(resolved.dbPath)).toBe(false)

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Storage.open({ ...input, channel: "dev" })
            const rows = yield* storage.query<{ name: string }>("SELECT name FROM marker")
            return { path: storage.path, names: rows.map((row) => row.name) }
          }),
        ),
      )
      expect(result.path).toBe(resolved.dbPath)
      expect(result.names).toEqual(["legacy-session"])
      expect(existsSync(resolved.dbPath)).toBe(true)
      expect(existsSync(legacy)).toBe(false)
    })
  })

  test("an existing canonical database wins and the legacy file stays byte-identical", async () => {
    await withTemp(async (directory) => {
      const input = { projectRoot: directory, env: { BANYANCODE_PROJECT_DB_DIR: directory } }
      const resolved = canonicalFor(directory)
      const legacy = join(directory, legacyName(resolved.filename, "dev"))

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Storage.open(input)
            yield* storage.exec("CREATE TABLE marker (name TEXT)")
            yield* storage.exec("INSERT INTO marker (name) VALUES ('canonical')")
          }),
        ),
      )
      await writeLegacy(legacy, ["legacy"])
      const before = await readFile(legacy)
      const sizeBefore = (await stat(legacy)).size

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Storage.open({ ...input, channel: "dev" })
            const rows = yield* storage.query<{ name: string }>("SELECT name FROM marker")
            return { path: storage.path, names: rows.map((row) => row.name) }
          }),
        ),
      )
      expect(result.path).toBe(resolved.dbPath)
      expect(result.names).toEqual(["canonical"])
      expect(existsSync(legacy)).toBe(true)
      expect((await stat(legacy)).size).toBe(sizeBefore)
      expect((await readFile(legacy)).equals(before)).toBe(true)
      expect(readMarkers(legacy)).toEqual(["legacy"])
    })
  })

  test("adoption is idempotent and picks the newest legacy family", async () => {
    await withTemp(async (directory) => {
      const resolved = canonicalFor(directory)
      const olderName = legacyName(resolved.filename, "local")
      const newerName = legacyName(resolved.filename, "dev")
      const older = join(directory, olderName)
      const newer = join(directory, newerName)

      await writeLegacy(older, ["older"])
      await writeLegacy(newer, ["newer"])
      const past = new Date(Date.now() - 60_000)
      const now = new Date()
      await utimes(older, past, past)
      await utimes(newer, now, now)

      expect(await adoptLegacyDatabase(resolved)).toEqual({ adopted: newerName })
      expect(readMarkers(resolved.dbPath)).toEqual(["newer"])
      expect(existsSync(newer)).toBe(false)
      // The older family is not the newest, so it is left alone.
      expect(existsSync(older)).toBe(true)

      expect(await adoptLegacyDatabase(resolved)).toEqual({})
      expect(readMarkers(resolved.dbPath)).toEqual(["newer"])
    })
  })

  test("two adopters racing on one project adopt exactly once", async () => {
    await withTemp(async (directory) => {
      const resolved = canonicalFor(directory)
      const legacyNameFor = legacyName(resolved.filename, "dev")
      await writeLegacy(join(directory, legacyNameFor), ["once"])

      const results = await Promise.all([adoptLegacyDatabase(resolved), adoptLegacyDatabase(resolved)])
      expect(results.filter((result) => result.adopted !== undefined)).toHaveLength(1)
      expect(results.map((result) => result.adopted).filter((name) => name !== undefined)).toEqual([legacyNameFor])
      expect(readMarkers(resolved.dbPath)).toEqual(["once"])
      expect(existsSync(join(directory, legacyNameFor))).toBe(false)
    })
  })

  test("a legacy source that disappears during adoption is success", async () => {
    await withTemp(async (directory) => {
      const resolved = canonicalFor(directory)
      const legacy = join(directory, legacyName(resolved.filename, "dev"))
      await expect(adoptFamily(legacy, resolved.dbPath)).resolves.toBe("missing")
      expect(existsSync(resolved.dbPath)).toBe(false)
      expect(existsSync(legacy)).toBe(false)
    })
  })

  test("two connections share one WAL database with a busy timeout", async () => {
    await withTemp(async (directory) => {
      const resolved = canonicalFor(directory)
      const writer = await openDatabase(resolved.dbPath)
      const reader = await openDatabase(resolved.dbPath)
      try {
        applyMigrations(writer)
        run(writer, "CREATE TABLE marker (name TEXT)")
        run(writer, "INSERT INTO marker (name) VALUES ('shared')")
        expect(query<{ timeout: number }>(reader, "PRAGMA busy_timeout")[0]?.timeout).toBe(5000)
        expect(query<{ journal_mode: string }>(reader, "PRAGMA journal_mode")[0]?.journal_mode).toBe("wal")
        expect(query<{ name: string }>(reader, "SELECT name FROM marker")).toEqual([{ name: "shared" }])
      } finally {
        reader.close()
        writer.close()
      }
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

  test("damage that only shows on a later query still gets the file moved aside", async () => {
    await withTemp(async (directory) => {
      const input = { projectRoot: directory, env: { BANYANCODE_PROJECT_DB_DIR: directory } }
      const resolved = resolveProjectDbPath(input)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Storage.open(input)
            yield* storage.exec("CREATE TABLE big (a TEXT)")
            yield* storage.exec(
              "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000) INSERT INTO big SELECT hex(randomblob(100)) FROM n",
            )
            yield* storage.exec("PRAGMA wal_checkpoint(TRUNCATE)")
          }),
        ),
      )
      const bytes = await readFile(resolved.dbPath)
      bytes.fill(0xff, Math.floor(bytes.length / 2))
      await writeFile(resolved.dbPath, bytes)

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Storage.open(input)
            const damaged = yield* Effect.exit(storage.query("SELECT COUNT(*), MAX(a) FROM big"))
            const rows = yield* storage.query<{ count: number }>("SELECT COUNT(*) AS count FROM banyancode_migrations")
            return { damaged: damaged._tag, count: rows[0]?.count }
          }),
        ),
      )
      expect(result.damaged).toBe("Failure")
      expect(result.count).toBe(migrations.length)
      expect((await readdir(directory)).some((name) => name.includes(".db-corrupt-"))).toBe(true)
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

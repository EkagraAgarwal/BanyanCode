import { rename } from "node:fs/promises"
import { Context, Effect, Layer, Schema } from "effect"
import { openDatabase } from "./driver.js"
import { acquireFileLock, withFileLock } from "./lock.js"
import { applyMigrations, detectFtsTokenizer, type FtsTokenizer } from "./migrate.js"
import type { Driver, NativeDatabase } from "./native.js"
import { resolveProjectDbPath } from "./paths.js"

export class StorageError extends Schema.TaggedError<StorageError>()("BanyanStorageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  /** Absolute path to the project database. */
  readonly path: string
  readonly driver: Driver
  /** Number of migrations recorded in `banyancode_migrations`. */
  readonly schemaVersion: number
  /** Every recorded migration id, ordered. */
  readonly appliedMigrations: readonly string[]
  readonly ftsTokenizer: FtsTokenizer
  readonly exec: (sql: string) => Effect.Effect<void, StorageError>
  readonly query: <A>(sql: string, params?: readonly unknown[]) => Effect.Effect<readonly A[], StorageError>
  /** Serialises a write batch against other processes sharing this database. */
  readonly withWriteLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | StorageError, R>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/Storage") {}

export interface OpenInput {
  readonly projectRoot: string
  readonly env?: NodeJS.ProcessEnv
  /** Host installation channel (`ctx.app.channel`); non-stable channels isolate plugin data. */
  readonly channel?: string
}

const corruptionMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : ""

/**
 * True only for SQLite's "this file is not a database" / "malformed" family.
 * Every other open failure (permissions, a directory in the way, a lock
 * timeout) must keep failing: moving a healthy file aside would be data loss.
 */
const isCorruptDatabaseError = (cause: unknown): boolean =>
  /not a database|database disk image is malformed|sqlite_notadb|sqlite_corrupt/i.test(corruptionMessage(cause))

/**
 * Moves an unreadable database (and its sidecars) out of the way, keeping the
 * bytes for diagnosis. Returns the new main-file path, or undefined when the
 * rename failed and the caller must report the original error.
 */
const moveCorruptDatabase = async (dbPath: string): Promise<string | undefined> => {
  const suffix = `-corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`
  const target = `${dbPath}${suffix}`
  try {
    await rename(dbPath, target)
  } catch {
    return undefined
  }
  for (const sidecar of ["-wal", "-shm", "-journal"]) {
    try {
      await rename(`${dbPath}${sidecar}`, `${target}${sidecar}`)
    } catch {
      // A missing sidecar is normal; a held one is not worth blocking recovery.
    }
  }
  return target
}

const openWithRecovery = (dbPath: string): Effect.Effect<NativeDatabase, StorageError> =>
  Effect.gen(function* () {
    const first = yield* Effect.tryPromise({
      try: () => openDatabase(dbPath),
      catch: (cause) => cause,
    }).pipe(Effect.result)
    if (first._tag === "Success") return first.success
    if (!isCorruptDatabaseError(first.failure)) {
      return yield* new StorageError({ message: `Failed to open the BanyanCode database at ${dbPath}`, cause: first.failure })
    }

    const moved = yield* Effect.tryPromise({
      try: () => moveCorruptDatabase(dbPath),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined))
    if (moved === undefined) {
      return yield* new StorageError({
        message: `Failed to open the BanyanCode database at ${dbPath} and could not move the corrupt file aside`,
        cause: first.failure,
      })
    }
    yield* Effect.logWarning(
      `BanyanCode database at ${dbPath} is corrupt (${corruptionMessage(first.failure)}); ` +
        `moved it to ${moved} and created a fresh database`,
    )
    return yield* Effect.tryPromise({
      try: () => openDatabase(dbPath),
      catch: (cause) =>
        new StorageError({
          message: `Failed to open a fresh BanyanCode database at ${dbPath} after moving the corrupt file to ${moved}`,
          cause,
        }),
    })
  })

/**
 * Opens (and migrates) the project database for the plugin scope. The handle
 * closes with the plugin scope; Bun uses `close(true)` so outstanding
 * statements do not pin the file.
 *
 * The database holds derived code-graph rows and mesh messages, so a corrupt
 * file is recoverable: it is moved aside and replaced instead of disabling the
 * whole plugin.
 */
export const open = Effect.fn("BanyanStorage.open")(function* (input: OpenInput) {
  const resolved = resolveProjectDbPath(input)
  const live = { db: yield* openWithRecovery(resolved.dbPath) }
  yield* Effect.addFinalizer(() => Effect.sync(() => live.db.close()))

  const migration = yield* Effect.tryPromise({
    try: () => withFileLock(`${resolved.dbPath}.migrate.lock`, () => Promise.resolve(applyMigrations(live.db))),
    catch: (cause) =>
      new StorageError({ message: `Failed to migrate the BanyanCode database at ${resolved.dbPath}`, cause }),
  })

  // A header can read fine with the damage further in (a stale WAL even rebuilds page one over a garbage file), so
  // opening doesn't prove the file is healthy. The same move-aside then applies to the first statement that fails.
  const replacing = { current: undefined as Promise<void> | undefined }
  const replaceCorrupt = () =>
    (replacing.current ??= (async () => {
      live.db.close()
      const moved = await moveCorruptDatabase(resolved.dbPath)
      live.db = await openDatabase(resolved.dbPath)
      if (moved === undefined) throw new Error(`could not move the corrupt database at ${resolved.dbPath} aside`)
      await withFileLock(`${resolved.dbPath}.migrate.lock`, () => Promise.resolve(applyMigrations(live.db)))
    })().finally(() => {
      replacing.current = undefined
    }))
  const recovering = <A>(message: string, statement: () => A) =>
    Effect.try({ try: statement, catch: (cause) => cause }).pipe(
      Effect.catch((cause) =>
        !isCorruptDatabaseError(cause)
          ? Effect.fail(new StorageError({ message, cause }))
          : Effect.logWarning(
              `BanyanCode database at ${resolved.dbPath} is corrupt (${corruptionMessage(cause)}); replacing it`,
            ).pipe(
              Effect.andThen(
                Effect.tryPromise({ try: replaceCorrupt, catch: (cause) => new StorageError({ message, cause }) }),
              ),
              Effect.andThen(Effect.try({ try: statement, catch: (cause) => new StorageError({ message, cause }) })),
            ),
      ),
    )

  const handle: Interface = {
    path: resolved.dbPath,
    driver: live.db.driver,
    schemaVersion: migration.version,
    appliedMigrations: migration.ids,
    ftsTokenizer: detectFtsTokenizer(live.db),
    exec: (sql) => recovering("Failed to execute SQL", () => live.db.exec(sql)),
    query: <A>(sql: string, params: readonly unknown[] = []) =>
      recovering("Failed to query the BanyanCode database", () => live.db.prepare(sql).all(...params) as readonly A[]),
    withWriteLock: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => acquireFileLock(`${resolved.dbPath}.write.lock`),
          catch: (cause) => new StorageError({ message: "Failed to acquire the BanyanCode write lock", cause }),
        }),
        () => effect,
        (lock) => Effect.promise(() => lock.release()),
      ),
  }
  return Service.of(handle)
})

export const layer = (input: OpenInput) => Layer.effect(Service, open(input))

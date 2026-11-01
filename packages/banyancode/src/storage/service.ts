import { Context, Effect, Layer, Schema } from "effect"
import { openDatabase } from "./driver.js"
import { acquireFileLock, withFileLock } from "./lock.js"
import { applyMigrations, detectFtsTokenizer, type FtsTokenizer } from "./migrate.js"
import type { Driver } from "./native.js"
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
}

/**
 * Opens (and migrates) the project database for the plugin scope. The handle
 * closes with the plugin scope; Bun uses `close(true)` so outstanding
 * statements do not pin the file.
 */
export const open = Effect.fn("BanyanStorage.open")(function* (input: OpenInput) {
  const resolved = resolveProjectDbPath(input)
  const db = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openDatabase(resolved.dbPath),
      catch: (cause) =>
        new StorageError({ message: `Failed to open the BanyanCode database at ${resolved.dbPath}`, cause }),
    }),
    (db) => Effect.sync(() => db.close()),
  )

  const migration = yield* Effect.tryPromise({
    try: () => withFileLock(`${resolved.dbPath}.migrate.lock`, () => Promise.resolve(applyMigrations(db))),
    catch: (cause) =>
      new StorageError({ message: `Failed to migrate the BanyanCode database at ${resolved.dbPath}`, cause }),
  })

  const handle: Interface = {
    path: resolved.dbPath,
    driver: db.driver,
    schemaVersion: migration.version,
    appliedMigrations: migration.ids,
    ftsTokenizer: detectFtsTokenizer(db),
    exec: (sql) =>
      Effect.try({
        try: () => db.exec(sql),
        catch: (cause) => new StorageError({ message: "Failed to execute SQL", cause }),
      }),
    query: <A>(sql: string, params: readonly unknown[] = []) =>
      Effect.try({
        try: () => db.prepare(sql).all(...params) as readonly A[],
        catch: (cause) => new StorageError({ message: "Failed to query the BanyanCode database", cause }),
      }),
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

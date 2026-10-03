import { createClient, type Client as LibsqlClient } from "@libsql/client"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import { Sqlite } from "./sqlite"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const TypeId = "~@opencode-ai/core/database/SqliteLibsql" as const
type TypeId = typeof TypeId

interface SqliteClient extends SqlClient.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: Config
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly updateValues: never
}

interface Config {
  readonly filename: string
  readonly readonly?: boolean
  readonly create?: boolean
  readonly readwrite?: boolean
  readonly disableWAL?: boolean
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: (str: string) => string
  readonly transformQueryNames?: (str: string) => string
}

interface SqliteConnection extends Connection {
  readonly export: Effect.Effect<Uint8Array, SqlError>
}

// SQLITE_BUSY (5) / SQLITE_LOCKED (6) are transient: the libsql driver's
// prepared statements are reclaimed by GC rather than finalized after use,
// so a COMMIT can race collection ("cannot commit transaction - SQL
// statements in progress"), and a second connection can briefly hold a table
// lock ("database table is locked"). Neither invokes the `busy_timeout`
// handler, so retry here with a GC hint + backoff instead of failing fast.
const TRANSIENT_SQLITE_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"])
const TRANSIENT_SQLITE_RAW_CODES = new Set([5, 6])

const isTransientSqliteError = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null) return false
  const record = cause as { code?: unknown; rawCode?: unknown; message?: unknown }
  if (typeof record.code === "string" && TRANSIENT_SQLITE_CODES.has(record.code)) return true
  if (typeof record.rawCode === "number" && TRANSIENT_SQLITE_RAW_CODES.has(record.rawCode)) return true
  const message = typeof record.message === "string" ? record.message : ""
  return message.startsWith("SQLITE_BUSY") || message.startsWith("SQLITE_LOCKED")
}

// Nudge GC so abandoned native statement handles (which block COMMIT until
// finalized) are reclaimed before the retry. Best-effort; never throws.
const hintGarbageCollection = (): void => {
  try {
    ;(globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun?.gc?.(true)
  } catch {
    // A GC hint must never break a query.
  }
}

const TRANSIENT_RETRIES = 5

// Retry backoff on a real timer, NOT `Effect.sleep`: test layers run under
// `TestClock` (see test/lib/effect.ts `testEnv`), whose clock only advances
// manually, so a sleep-based backoff never resolves when a transient
// SQLITE_BUSY/LOCKED fires there. The teardown checkpoint deterministically
// hits SQLITE_LOCKED (build-time statements are still unfinalized — the
// libsql driver reclaims them via GC), which hung every suite using a
// Database layer in post-body teardown. Worst case is ~155ms of real delay
// per operation; interruption clears the timer.
const realDelay = (millis: number): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const timeoutId = setTimeout(() => {
      resume(Effect.void)
    }, millis)
    return Effect.sync(() => clearTimeout(timeoutId))
  })

const withTransientRetry = <A>(runEffect: () => Effect.Effect<A, unknown>): Effect.Effect<A, unknown> => {
  const attempt = (left: number): Effect.Effect<A, unknown> =>
    Effect.catchIf(
      runEffect(),
      (cause) => left > 0 && isTransientSqliteError(cause),
      () =>
        Effect.suspend(() => {
          hintGarbageCollection()
          return realDelay(Math.min(5 * 2 ** (TRANSIENT_RETRIES - left), 80)).pipe(
            Effect.andThen(attempt(left - 1)),
          )
        }),
    )
  return attempt(TRANSIENT_RETRIES)
}

const failedToExecute = (cause: unknown) =>
  new SqlError({
    reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
  })

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as LibsqlClient

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      withTransientRetry(() =>
        Effect.tryPromise({
          try: async () => {
            const result = await native.execute({ sql: query, args: params as any[] })
            return result.rows as Array<Record<string, unknown>>
          },
          catch: (cause) => cause,
        }),
      ).pipe(Effect.mapError(failedToExecute))

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      withTransientRetry(() =>
        Effect.tryPromise({
          try: async () => {
            const result = await native.execute({ sql: query, args: params as any[] })
            return result.rows.map((row) => Object.values(row)) as Array<unknown[]>
          },
          catch: (cause) => cause,
        }),
      ).pipe(Effect.mapError(failedToExecute))

    const exportDb = Effect.tryPromise({
      try: async () => {
        const result = await native.execute({ sql: "SELECT 1", args: [] })
        void result
        return new Uint8Array(0)
      },
      catch: (cause) =>
        new SqlError({
          reason: classifySqliteError(cause, { message: "Failed to export database", operation: "export" }),
        }),
    })

    const connection = identity<SqliteConnection>({
      execute(query, params, transformRows) {
        return transformRows ? Effect.map(run(query, params), transformRows) : run(query, params)
      },
      executeRaw(query, params) {
        return run(query, params)
      },
      executeValues(query, params) {
        return runValues(query, params)
      },
      executeUnprepared(query, params, transformRows) {
        return this.execute(query, params, transformRows)
      },
      executeStream() {
        return Stream.die("executeStream not implemented")
      },
      export: exportDb,
    })

    const semaphore = yield* Semaphore.make(1)
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
        connection,
      )
    })

    const client = Object.assign(
      (yield* SqlClient.make({
        acquirer,
        compiler,
        transactionAcquirer,
        spanAttributes: [
          ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
          [ATTR_DB_SYSTEM_NAME, "sqlite"],
        ],
        transformRows,
      })) as SqliteClient,
      {
        [TypeId]: TypeId,
        config: options,
        export: Effect.flatMap(acquirer, (_) => _.export),
      },
    )

    return client
  })

// Direct native executes (startup PRAGMAs, teardown checkpoint) go through the
// same transient retry as queries. Unlike `Effect.promise` — whose rejection
// is a *defect* that `Effect.ignore` cannot swallow — this maps failures to
// `SqlError`, so teardown stays infallible via `Effect.ignore`. Startup
// PRAGMAs are converted back to defects with `Effect.orDie` at the layer
// build boundary below, keeping the layer's declared error channel `never`
// (matching the pre-retry `Effect.promise` behavior); only the runtime query
// paths (run/runValues) keep typed `SqlError` failures.
const runNative = (client: LibsqlClient, sql: string) =>
  withTransientRetry(() =>
    Effect.tryPromise({
      try: () => client.execute({ sql, args: [] }),
      catch: (cause) => cause,
    }),
  ).pipe(Effect.mapError(failedToExecute))

const closeClient = (client: LibsqlClient) =>
  Effect.sync(() => {
    try {
      client.close()
    } catch {
      // Close is best-effort during teardown (e.g. already-closed handle).
    }
  })

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      // @libsql/client requires file: URL for local files
      const url = config.filename.startsWith("file:") ? config.filename : `file:${config.filename}`
      const client = createClient({
        url,
      })
      // Teardown: checkpoint the WAL before close so a scoped DB (test tmpdirs
      // in particular) releases its -wal/-shm locks synchronously instead of
      // leaving them held past scope teardown — a fast test that finishes before
      // the libsql driver settles would otherwise EBUSY on rm of the tempdir.
      // PASSIVE is required (not TRUNCATE): other processes (subagent workers,
      // external sqlite3) may hold in-flight WAL transactions, and TRUNCATE
      // resets the WAL out from under them, corrupting the DB.
      yield* Effect.addFinalizer(() =>
        runNative(client, "PRAGMA wal_checkpoint(PASSIVE)").pipe(
          Effect.ignore,
          Effect.andThen(closeClient(client)),
        ),
      )
      // Apply PRAGMAs at startup
      yield* runNative(client, "PRAGMA journal_mode = WAL")
      yield* runNative(client, "PRAGMA synchronous = NORMAL")
      yield* runNative(client, "PRAGMA busy_timeout = 5000")
      // ~16MB page cache (negative = kibibytes); was -64000 (~64MB).
      yield* runNative(client, "PRAGMA cache_size = -16000")
      yield* runNative(client, "PRAGMA foreign_keys = ON")
      yield* runNative(client, "PRAGMA temp_store = MEMORY")
      // Only set page_size if not already set
      const pageSizeResult = yield* runNative(client, "PRAGMA page_size")
      if (pageSizeResult.rows.length === 0 || pageSizeResult.rows[0]["page_size"] === 0) {
        yield* runNative(client, "PRAGMA page_size = 8192")
      }
      return client
      // Construction boundary: startup PRAGMA failures become defects so the
      // layer's declared error channel stays `never`. Runtime query paths
      // (run/runValues) keep their typed SqlError errors untouched.
    }).pipe(Effect.orDie),
  )

const sqliteLayer = (config: Config) => Layer.effect(SqlClient.SqlClient, make(config))

// Drizzle is not used directly - EffectDrizzleSqlite uses SqlClient.SqlClient
const drizzleLayer = Layer.succeed(
  Sqlite.Drizzle,
  {} as any,
)

export const layer = (config: Config) => {
  const native = nativeLayer(config)
  return Layer.merge(native, Layer.merge(sqliteLayer(config), drizzleLayer).pipe(Layer.provide(native))).pipe(
    Layer.provide(Reactivity.layer),
  )
}

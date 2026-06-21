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

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as LibsqlClient

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.tryPromise({
        try: async () => {
          const result = await native.execute({ sql: query, args: params as any[] })
          return result.rows as Array<Record<string, unknown>>
        },
        catch: (cause) =>
          new SqlError({
            reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
          }),
      })

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.tryPromise({
        try: async () => {
          const result = await native.execute({ sql: query, args: params as any[] })
          return result.rows.map((row) => Object.values(row)) as Array<unknown[]>
        },
        catch: (cause) =>
          new SqlError({
            reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
          }),
      })

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

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      // @libsql/client requires file: URL for local files
      const url = config.filename.startsWith("file:") ? config.filename : `file:${config.filename}`
      console.error(`[turso.driver] opening ${url}`)
      const client = createClient({
        url,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => { client.close() }))
      // Apply PRAGMAs at startup
      yield* Effect.promise(() => client.execute({ sql: "PRAGMA journal_mode = WAL", args: [] }))
      yield* Effect.promise(() => client.execute({ sql: "PRAGMA synchronous = NORMAL", args: [] }))
      yield* Effect.promise(() => client.execute({ sql: "PRAGMA busy_timeout = 5000", args: [] }))
      yield* Effect.promise(() => client.execute({ sql: "PRAGMA cache_size = -64000", args: [] }))
      yield* Effect.promise(() => client.execute({ sql: "PRAGMA foreign_keys = ON", args: [] }))
      yield* Effect.promise(() => client.execute({ sql: "PRAGMA mmap_size = 268435456", args: [] }))
      yield* Effect.promise(() => client.execute({ sql: "PRAGMA temp_store = MEMORY", args: [] }))
      // Only set page_size if not already set
      const pageSizeResult = yield* Effect.promise(() => client.execute({ sql: "PRAGMA page_size", args: [] }))
      if (pageSizeResult.rows.length === 0 || pageSizeResult.rows[0]["page_size"] === 0) {
        yield* Effect.promise(() => client.execute({ sql: "PRAGMA page_size = 8192", args: [] }))
      }
      return client
    }),
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

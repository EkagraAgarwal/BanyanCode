import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { openNative } from "#sqlite"
import type { NativeDatabase } from "./native.js"

export type { Driver, NativeDatabase, NativeStatement } from "./native.js"

/**
 * Opens the project database and applies the connection pragmas every
 * consumer relies on. WAL is the v1 choice; `busy_timeout` covers the brief
 * overlap while a second process (or a test) holds the write lock.
 */
export const openDatabase = async (path: string): Promise<NativeDatabase> => {
  await mkdir(dirname(path), { recursive: true })
  const db = openNative(path)
  db.exec(
    [
      "PRAGMA journal_mode = WAL",
      "PRAGMA synchronous = NORMAL",
      "PRAGMA busy_timeout = 5000",
      "PRAGMA foreign_keys = ON",
    ].join(";"),
  )
  return db
}

export const query = <A>(db: NativeDatabase, sql: string, params: readonly unknown[] = []): A[] =>
  db.prepare(sql).all(...params) as A[]

export const run = (db: NativeDatabase, sql: string, params: readonly unknown[] = []): void => {
  db.prepare(sql).run(...params)
}

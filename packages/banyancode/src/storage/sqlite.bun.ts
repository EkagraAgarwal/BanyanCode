import { Database } from "bun:sqlite"
import type { NativeDatabase, NativeStatement } from "./native.js"

export const openNative = (path: string): NativeDatabase => {
  const db = new Database(path, { create: true, readwrite: true })
  return {
    driver: "bun:sqlite",
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql) as unknown as NativeStatement,
    // Bun keeps the file handle open until outstanding statements finalize;
    // close(true) finalizes them (spike finding, and the v1 database lesson).
    close: () => db.close(true),
  }
}

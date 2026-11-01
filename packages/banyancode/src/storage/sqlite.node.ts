import { DatabaseSync } from "node:sqlite"
import type { NativeDatabase, NativeStatement } from "./native.js"

export const openNative = (path: string): NativeDatabase => {
  const db = new DatabaseSync(path)
  return {
    driver: "node:sqlite",
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql) as unknown as NativeStatement,
    close: () => db.close(),
  }
}

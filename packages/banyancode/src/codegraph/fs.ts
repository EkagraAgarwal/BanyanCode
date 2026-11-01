/**
 * Small filesystem helper layer for the codegraph indexer.
 *
 * v1 used `FSUtil.Service` (`packages/core/src/fs-util.ts`) — an Effect
 * service wrapping the platform filesystem. The indexer only needs five
 * operations, so the v2 port keeps them as plain functions that return
 * Effects, with no service indirection.
 */
import { Effect } from "effect"
import { existsSync } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"

export interface DirEntry {
  readonly name: string
  readonly type: "file" | "directory" | "other"
}

export const existsSafe = (path: string): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      return existsSync(path)
    } catch {
      return false
    }
  })

export const readFileStringSafe = (path: string): Effect.Effect<string | undefined> =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(Effect.orElseSucceed(() => undefined))

export interface StatInfo {
  readonly size: number
  readonly mtimeMs: number
  readonly isDirectory: boolean
}

/** `undefined` means the file vanished between the walk and the stat. */
export const statSafe = (path: string): Effect.Effect<StatInfo | undefined> =>
  Effect.tryPromise(async () => {
    const stats = await stat(path)
    return { size: stats.size, mtimeMs: stats.mtimeMs, isDirectory: stats.isDirectory() }
  }).pipe(Effect.orElseSucceed(() => undefined))

export const readDirectoryEntries = (path: string): Effect.Effect<readonly DirEntry[]> =>
  Effect.tryPromise(async () => {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.map(
      (entry): DirEntry => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      }),
    )
  }).pipe(Effect.orElseSucceed(() => [] as readonly DirEntry[]))

export const fs = {
  existsSafe,
  readFileStringSafe,
  stat: statSafe,
  readDirectoryEntries,
}

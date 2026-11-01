import { createReadStream, createWriteStream, realpathSync } from "node:fs"
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, win32 } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

/**
 * Small filesystem surface the v1 LSP runtime used
 * (`packages/opencode/src/util/filesystem.ts`). Deliberately local to the LSP
 * module so the plugin gains no new dependency and no host coupling.
 */

export const exists = (p: string): Promise<boolean> =>
  stat(p)
    .then(() => true)
    .catch(() => false)

export const readText = (p: string): Promise<string> => readFile(p, "utf8")

export const write = (p: string, data: string | Uint8Array): Promise<void> => writeFile(p, data)

export const mkdirp = (p: string): Promise<void> => mkdir(p, { recursive: true }).then(() => undefined)

export const remove = (p: string, recursive = false): Promise<void> => rm(p, { recursive, force: true })

export const ls = (p: string): Promise<string[]> => readdir(p).catch(() => [])

export const statOf = (p: string): Promise<{ mtimeMs: number; size: number } | undefined> =>
  stat(p).then(
    (value) => ({ mtimeMs: value.mtimeMs, size: value.size }),
    () => undefined,
  )

export const chmodSafe = (p: string, mode: number): Promise<void> =>
  chmod(p, mode).catch(() => undefined)

export const renamePath = (from: string, to: string): Promise<void> => rename(from, to)

export const writeStream = async (p: string, stream: ReadableStream<Uint8Array>, mode?: number): Promise<void> => {
  await mkdirp(dirname(p))
  const source = Readable.fromWeb(stream as never)
  await pipeline(source, createWriteStream(p))
  if (mode) await chmodSafe(p, mode)
}

export const readStream = (p: string): Readable => createReadStream(p)

/**
 * v1 `Filesystem.up`: yields matches from `start` upward. Kept as an async
 * generator so callers can consume only the first match and stop.
 */
export async function* up(options: { targets: string[]; start: string; stop?: string }) {
  let current = options.start
  while (true) {
    for (const target of options.targets) {
      const search = join(current, target)
      if (await exists(search)) yield search
    }
    if (options.stop === current) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

/** v1 `Filesystem.findUp`: every match from `start` upward, nearest first. */
export async function findUp(target: string | string[], start: string, stop?: string): Promise<string[]> {
  const dirs = [start]
  let current = start
  while (true) {
    if (stop === current) break
    const parent = dirname(current)
    if (parent === current) break
    dirs.push(parent)
    current = parent
  }
  const targets = Array.isArray(target) ? target : [target]
  const result: string[] = []
  for (const dir of dirs) {
    for (const item of targets) {
      const search = join(dir, item)
      if (await exists(search)) result.push(search)
    }
  }
  return result
}

/** First `up` match, or `fallback` when none is found. */
export async function nearestRoot(targets: string[], start: string, stop: string): Promise<string | undefined> {
  const files = up({ targets, start, stop })
  const first = await files.next()
  await files.return(undefined)
  return first.done ? undefined : first.value
}

/** v1 `Filesystem.normalizePath` (Windows canonicalization; no-op elsewhere). */
export function normalizePath(p: string): string {
  if (process.platform !== "win32") return p
  const resolved = win32.normalize(win32.resolve(p))
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

export const absolute = (directory: string, p: string): string => normalizePath(isAbsolute(p) ? p : resolve(directory, p))

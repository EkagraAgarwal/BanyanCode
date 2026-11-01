import { mkdir, open as openFile, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"

export interface FileLock {
  readonly path: string
  release(): Promise<void>
}

export interface FileLockOptions {
  /** Give up after this many milliseconds. Default 10s. */
  readonly timeoutMs?: number
  /** Treat a lock file older than this as abandoned. Default 30s. */
  readonly staleMs?: number
  /** Poll interval. Default 25ms. */
  readonly retryMs?: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Cross-process exclusive lock backed by an atomically-created file
 * (`open(..., "wx")`). The plugin activates once per location inside one
 * process; this guards the remaining cross-process cases (two servers, a test
 * beside a running binary) around migration and write batches.
 */
export const acquireFileLock = async (lockPath: string, options: FileLockOptions = {}): Promise<FileLock> => {
  const timeoutMs = options.timeoutMs ?? 10_000
  const staleMs = options.staleMs ?? 30_000
  const retryMs = options.retryMs ?? 25
  const started = Date.now()
  await mkdir(dirname(lockPath), { recursive: true })

  while (true) {
    try {
      const handle = await openFile(lockPath, "wx")
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
      } finally {
        await handle.close()
      }
      let released = false
      return {
        path: lockPath,
        release: async () => {
          if (released) return
          released = true
          await rm(lockPath, { force: true })
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const info = await stat(lockPath).catch(() => undefined)
      if (info && Date.now() - info.mtimeMs > staleMs) {
        await rm(lockPath, { force: true })
        continue
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for lock ${lockPath}`)
      }
      await sleep(retryMs)
    }
  }
}

export const withFileLock = async <A>(
  lockPath: string,
  fn: () => Promise<A>,
  options?: FileLockOptions,
): Promise<A> => {
  const lock = await acquireFileLock(lockPath, options)
  try {
    return await fn()
  } finally {
    await lock.release()
  }
}

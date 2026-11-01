import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const fixturePath = fileURLToPath(new URL("./fixture-server.ts", import.meta.url))

export const tempDir = (name: string) => mkdtemp(join(tmpdir(), `banyancode-lsp-${name}-`))

/**
 * Removes a temp directory. Windows keeps the child's cwd handle for a moment
 * after exit, so retry briefly; a leftover temp dir is harmless.
 */
export const cleanup = async (directory: string) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 1 })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

export const write = (file: string, content: string) => writeFile(file, content, "utf8")
export const read = (file: string) => readFile(file, "utf8")

export const fixtureCommand = (pidFile?: string) =>
  [process.execPath, fixturePath, ...(pidFile ? [pidFile] : [])] as string[]

export const configFile = (directory: string, command: string[], overrides: Record<string, unknown> = {}) =>
  write(
    join(directory, "banyancode.json"),
    JSON.stringify(
      {
        banyancode_lsp: {
          fixture: { command, extensions: [".fixture"], ...overrides },
        },
      },
      null,
      2,
    ),
  )

/** True while the OS process exists; never signals the process. */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const waitFor = async <T>(
  check: () => T | Promise<T>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> => {
  const timeoutMs = options.timeoutMs ?? 5_000
  const intervalMs = options.intervalMs ?? 50
  const started = Date.now()
  let last: unknown
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check()
      if (value) return value
      last = value
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms (last: ${String(last)})`)
}

export const pidFromFile = async (file: string, timeoutMs = 5_000): Promise<number> =>
  waitFor(
    async () => {
      if (!existsSync(file)) return 0
      const text = (await read(file)).trim()
      const pid = Number.parseInt(text, 10)
      return Number.isFinite(pid) && pid > 0 ? pid : 0
    },
    { timeoutMs },
  )

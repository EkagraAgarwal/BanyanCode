import { readdir, rename, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { withFileLock } from "./lock.js"

const SIDECARS = ["-wal", "-shm", "-journal"] as const
const RENAME_ATTEMPTS = 5

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const statOrUndefined = (path: string) =>
  stat(path).then(
    (info) => info,
    () => undefined,
  )

/**
 * Rename that tolerates the Windows cases. A lingering handle on either file
 * fails with `EBUSY`/`EPERM`; retrying briefly clears the common (antivirus,
 * just-closed) variants. `ENOENT` means the source is already gone.
 */
const renameWithRetry = async (source: string, target: string): Promise<"renamed" | "missing"> => {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, target)
      return "renamed"
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === "ENOENT") return "missing"
      if ((code !== "EBUSY" && code !== "EPERM") || attempt >= RENAME_ATTEMPTS - 1) throw cause
      await sleep(50 * (attempt + 1))
    }
  }
}

export type FamilyOutcome = "adopted" | "missing"

/**
 * Moves a legacy suffixed family (`banyancode-<hash>-<channel>.db` plus its
 * `-wal`/`-shm`/`-journal` sidecars) onto the canonical name.
 *
 * The main file moves first: if that rename fails, no sidecar moves and the
 * legacy family stays exactly as it was, so the old build keeps working. A
 * missing main file is success — another process adopted it first.
 */
export const adoptFamily = async (source: string, target: string): Promise<FamilyOutcome> => {
  if ((await renameWithRetry(source, target)) === "missing") return "missing"
  for (const sidecar of SIDECARS) {
    // The main file is canonical now; a sidecar that will not move only strands
    // its committed pages, which is worth continuing through rather than
    // failing the open.
    await renameWithRetry(`${source}${sidecar}`, `${target}${sidecar}`).catch(() => undefined)
  }
  return "adopted"
}

export interface AdoptResult {
  /** Legacy main-file name that became the canonical database. */
  readonly adopted?: string
  /** The legacy file exists but could not be adopted; it was left untouched. */
  readonly warning?: string
}

const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * Before a channel-agnostic build opens the project database, an older build
 * may have written one file per channel. When the canonical file is absent,
 * adopt the newest legacy family for this project hash by renaming it into
 * place; when the canonical file exists, legacy files are never touched (the
 * old file stays on disk, unused and recoverable).
 *
 * The whole check runs under the database's existing `<db>.migrate.lock`, so
 * two processes starting together cannot both adopt. Adoption is idempotent: a
 * second run sees the canonical file and does nothing, and a source that
 * vanished is success.
 *
 * Never throws: a stale legacy file must not stop BanyanCode from starting.
 */
export const adoptLegacyDatabase = async (resolved: { readonly dbPath: string }): Promise<AdoptResult> => {
  if (await statOrUndefined(resolved.dbPath)) return {}
  const directory = dirname(resolved.dbPath)
  const hash = /^banyancode-([0-9a-f]{12})\.db$/.exec(basename(resolved.dbPath))?.[1]
  if (hash === undefined) return {}

  try {
    return await withFileLock(`${resolved.dbPath}.migrate.lock`, async () => {
      // A process that lost the race has the canonical file already in place.
      if (await statOrUndefined(resolved.dbPath)) return {}
      const legacy = new RegExp(`^banyancode-${hash}-.+\\.db$`)
      const candidates = await readdir(directory).then(
        (names) => names.filter((name) => legacy.test(name)),
        () => [],
      )
      if (candidates.length === 0) return {}

      const newest = await Promise.all(
        candidates.map(async (name) => ({
          name,
          mtimeMs: (await statOrUndefined(join(directory, name)))?.mtimeMs ?? 0,
        })),
      ).then((entries) => entries.reduce((best, entry) => (entry.mtimeMs > best.mtimeMs ? entry : best)))

      try {
        if ((await adoptFamily(join(directory, newest.name), resolved.dbPath)) === "missing") return {}
        return { adopted: newest.name }
      } catch (cause) {
        return {
          warning:
            `Found a legacy BanyanCode database at ${join(directory, newest.name)} but could not move it to ` +
            `${resolved.dbPath} (${reason(cause)}); left it untouched and started a fresh database instead`,
        }
      }
    })
  } catch (cause) {
    return {
      warning:
        `Could not check ${directory} for a legacy BanyanCode database (${reason(cause)}); ` +
        `continuing with ${resolved.dbPath}`,
    }
  }
}

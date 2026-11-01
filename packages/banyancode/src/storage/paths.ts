import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { Global } from "@opencode/util/global"

export const shortHash = (input: string): string => createHash("sha256").update(input).digest("hex").slice(0, 12)

/**
 * Realpath first so two paths that point at the same tree (symlink, 8.3 short
 * name) derive the same database filename. Falls back to `resolve` when the
 * root does not exist yet.
 */
export const canonicalRoot = (input: string): string => {
  try {
    return realpathSync.native(input)
  } catch {
    return resolve(input)
  }
}

export interface ProjectDbPath {
  /** Canonical (realpath'd) project root used for the filename hash. */
  readonly root: string
  /** Directory that holds the database file. */
  readonly directory: string
  readonly filename: string
  readonly dbPath: string
}

export interface ProjectDbPathInput {
  readonly projectRoot: string
  readonly env?: NodeJS.ProcessEnv
}

/**
 * One SQLite file per project, named
 * `banyancode-<sha256(realpath(project)).slice(0,12)>.db` under the product
 * data directory (`<data>/projects/`), not inside the project: v2 keeps
 * locations open until shutdown, and an open handle inside the repo would stop
 * Windows users from moving or deleting the repo while BanyanCode runs.
 *
 * `BANYANCODE_PROJECT_DB_DIR` overrides the directory and keeps the hashed
 * filename, so two test roots never collide with a real running binary.
 */
export const resolveProjectDbPath = (input: ProjectDbPathInput): ProjectDbPath => {
  const root = canonicalRoot(input.projectRoot)
  const override = (input.env ?? process.env).BANYANCODE_PROJECT_DB_DIR?.trim()
  const directory = override && override.length > 0 ? override : join(Global.Path.data, "projects")
  const filename = `banyancode-${shortHash(root)}.db`
  return { root, directory, filename, dbPath: join(directory, filename) }
}

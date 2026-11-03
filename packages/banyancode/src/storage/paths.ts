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

/** Channels that v1 treated as stable. Kept for callers that still name the set. */
export const STABLE_CHANNELS: ReadonlyArray<string> = ["latest", "beta", "prod"]

/**
 * Legacy, always `""`. v1 (and early v2) gave every non-stable channel its own
 * database file, so a dev canary could not touch stable plugin data. Every
 * channel now shares one project database: a chat started on a stable build is
 * still there after switching to a dev build. Older builds wrote
 * `banyancode-<hash>-<channel>.db`; `adoptLegacyDatabase` renames the newest one
 * to the canonical name on first open, so the argument and the
 * `BANYANCODE_DISABLE_CHANNEL_DB` opt-out no longer change the path. The export
 * stays so callers (and `banyancode db gc`) keep one definition of the current
 * filename.
 */
export const channelSuffix = (channel: string | undefined, env: NodeJS.ProcessEnv = process.env): string => ""

export interface ProjectDbPath {
  /** Canonical (realpath'd) project root used for the filename hash. */
  readonly root: string
  /** Directory that holds the database file. */
  readonly directory: string
  /** Installation-channel suffix including its leading dash. Always empty now. */
  readonly channelSuffix: string
  readonly filename: string
  readonly dbPath: string
}

export interface ProjectDbPathInput {
  readonly projectRoot: string
  readonly env?: NodeJS.ProcessEnv
  /** Host installation channel (`ctx.app.channel`). Accepted but no longer affects the path. */
  readonly channel?: string
}

/**
 * One SQLite file per project, named
 * `banyancode-<sha256(realpath(project)).slice(0,12)>.db` under the product data
 * directory (`<data>/projects/`), not inside the project: v2 keeps locations
 * open until shutdown, and an open handle inside the repo would stop Windows
 * users from moving or deleting the repo while BanyanCode runs.
 *
 * The filename does not depend on the installation channel: stable, dev and
 * canary builds share one database, and legacy per-channel files are adopted on
 * first open (see `adoptLegacyDatabase`).
 *
 * `BANYANCODE_PROJECT_DB_DIR` overrides the directory and keeps the hashed
 * filename, so two test roots never collide with a real running binary.
 */
export const resolveProjectDbPath = (input: ProjectDbPathInput): ProjectDbPath => {
  const root = canonicalRoot(input.projectRoot)
  const env = input.env ?? process.env
  const override = env.BANYANCODE_PROJECT_DB_DIR?.trim()
  const directory = override && override.length > 0 ? override : join(Global.Path.data, "projects")
  const suffix = channelSuffix(input.channel, env)
  const filename = `banyancode-${shortHash(root)}${suffix}.db`
  return { root, directory, channelSuffix: suffix, filename, dbPath: join(directory, filename) }
}

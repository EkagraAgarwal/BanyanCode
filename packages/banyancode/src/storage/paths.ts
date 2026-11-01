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

/**
 * Channels that share one database. v1 `channelSuffix()` treated
 * latest/beta/prod as stable; v2 keeps the same set so a stable install never
 * gets a `-latest` suffix.
 */
export const STABLE_CHANNELS: ReadonlyArray<string> = ["latest", "beta", "prod"]

export const channelSuffix = (channel: string | undefined, env: NodeJS.ProcessEnv = process.env): string => {
  if (channel === undefined || channel.trim().length === 0) return ""
  if (STABLE_CHANNELS.includes(channel)) return ""
  if (env.BANYANCODE_DISABLE_CHANNEL_DB === "1" || env.BANYANCODE_DISABLE_CHANNEL_DB === "true") return ""
  return `-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}`
}

export interface ProjectDbPath {
  /** Canonical (realpath'd) project root used for the filename hash. */
  readonly root: string
  /** Directory that holds the database file. */
  readonly directory: string
  /** Installation-channel suffix including its leading dash, or empty. */
  readonly channelSuffix: string
  readonly filename: string
  readonly dbPath: string
}

export interface ProjectDbPathInput {
  readonly projectRoot: string
  readonly env?: NodeJS.ProcessEnv
  /** Host installation channel (`ctx.app.channel`); `latest` keeps the plain filename. */
  readonly channel?: string
}

/**
 * One SQLite file per project, named
 * `banyancode-<sha256(realpath(project)).slice(0,12><-channel>.db` under the
 * product data directory (`<data>/projects/`), not inside the project: v2
 * keeps locations open until shutdown, and an open handle inside the repo
 * would stop Windows users from moving or deleting the repo while BanyanCode
 * runs.
 *
 * Non-stable channels get a `-<channel>` suffix so a dev/canary build never
 * touches stable plugin data (v1 `channelSuffix()` behavior).
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

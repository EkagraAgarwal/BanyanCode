import { statSync } from "node:fs"
import { InstallationChannel } from "../installation/version"
import { path } from "./database"

export const LARGE_DB_WARN_BYTES = 1024 ** 3

export interface DbReport {
  readonly path: string
  readonly channel: string
  /** `.db` plus `-wal`/`-shm` siblings. */
  readonly bytes: number
  readonly warning?: string
}

/** Stat-only description of the DB this process will open. Never throws. */
export const dbReport = (dbPath: string = path()): DbReport => {
  const bytes = ["", "-wal", "-shm"].reduce((total, suffix) => {
    try {
      return total + statSync(`${dbPath}${suffix}`).size
    } catch {
      return total
    }
  }, 0)
  const gb = (bytes / 1024 ** 3).toFixed(1)
  return {
    path: dbPath,
    channel: InstallationChannel,
    bytes,
    ...(bytes > LARGE_DB_WARN_BYTES && {
      warning: `banyancode database is ${gb} GB (${dbPath}). If the TUI stalls or misbehaves, back it up and run \`banyancode codegraph remove\`, or delete it to rebuild.`,
    }),
  }
}

export * as DbReport from "./db-report"

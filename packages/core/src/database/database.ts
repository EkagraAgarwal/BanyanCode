export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { createHash } from "node:crypto"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { LayerNode } from "../effect/layer-node"
import fs from "node:fs"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

function findProjectRoot(startDir: string): string | undefined {
  let dir = startDir
  const markers = [".git", "banyancode.json", "opencode.json", ".banyancode", ".opencode", "package.json", "Cargo.toml", "go.mod"]
  while (true) {
    for (const marker of markers) {
      const candidate = join(dir, marker)
      try {
        if (fs.existsSync(candidate)) {
          return dir
        }
      } catch {
        // ignore
      }
    }
    const parent = join(dir, "..")
    if (parent === dir) {
      break
    }
    dir = parent
  }
  return undefined
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12)
}

function findOrCreateBanyanProjectDir(startDir: string): string | undefined {
  let dir = startDir
  while (true) {
    const candidate = join(dir, ".banyancode")
    try {
      const stat = fs.statSync(candidate)
      if (stat.isDirectory()) {
        return candidate
      }
    } catch {
      // ignore
    }
    const parent = join(dir, "..")
    if (parent === dir) {
      break
    }
    dir = parent
  }

  const root = findProjectRoot(startDir) ?? startDir
  const targetDir = join(root, ".banyancode")
  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }
    return targetDir
  } catch {
    return undefined
  }
}

export function path() {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return join(Global.Path.data, Flag.OPENCODE_DB)
  }

  const projectBanyanDir = findOrCreateBanyanProjectDir(process.cwd())
  if (projectBanyanDir) {
    // BANYANCODE_LEGACY_DB_PATH=1 falls back to the old filename for one
    // release cycle so existing per-project DBs are not silently abandoned.
    const legacy =
      process.env.BANYANCODE_LEGACY_DB_PATH === "1" || process.env.BANYANCODE_LEGACY_DB_PATH === "true"
    if (legacy) {
      if (
        ["latest", "beta", "prod"].includes(InstallationChannel) ||
        process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
        process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
      )
        return join(projectBanyanDir, "banyancode.db")
      return join(projectBanyanDir, `banyancode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
    }
    // Include a hash of the workspace root so two workspaces in the same
    // project tree never share a single banyancode.db (the singleton
    // codegraph_meta row would otherwise let the second workspace's
    // indexed_root overwrite the first's, breaking auto-update isolation).
    const workspaceTag = shortHash(process.cwd())
    const channelSuffix =
      ["latest", "beta", "prod"].includes(InstallationChannel) ||
      process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
      process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
        ? ""
        : `-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}`
    return join(projectBanyanDir, `banyancode-${workspaceTag}${channelSuffix}.db`)
  }

  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.banyan.data, "banyancode.db")
  return join(Global.Path.banyan.data, `banyancode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

export const defaultLayer = Layer.unwrap(
  Effect.gen(function* () {
    return layerFromPath(path())
  }),
).pipe(Layer.provide(Global.defaultLayer))

export const node = LayerNode.make(layerFromPath(path()), [])

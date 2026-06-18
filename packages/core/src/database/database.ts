export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
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

function findBanyanProjectDir(startDir: string): string | undefined {
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
  return undefined
}

export function path() {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return join(Global.Path.data, Flag.OPENCODE_DB)
  }

  const projectBanyanDir = findBanyanProjectDir(process.cwd())
  if (projectBanyanDir) {
    if (
      ["latest", "beta", "prod"].includes(InstallationChannel) ||
      process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
      process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
    )
      return join(projectBanyanDir, "banyancode.db")
    return join(projectBanyanDir, `banyancode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
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

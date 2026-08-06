export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { LayerNode } from "../effect/layer-node"
import fs from "node:fs"
import { channelSuffix, deriveBanyanDbPath, findContainingBanyanDir } from "./banyan-db-path"

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

function findOrCreateBanyanProjectDir(startDir: string): string | undefined {
  // findContainingBanyanDir skips a `.banyancode` marker that sits at the
  // filesystem root (e.g. `D:\.banyancode`), so a polluted drive root never
  // hijacks child projects; the marker is only honored when startDir itself
  // IS the filesystem root.
  const existing = findContainingBanyanDir(startDir)
  if (existing) return existing
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
    // The filename derivation (realpath hash + installation-channel suffix)
    // is shared with WorkspaceIdentity.identityForRoot so the process-wide
    // DB and the codegraph DB agree when the server starts from the
    // workspace root.
    return deriveBanyanDbPath(projectBanyanDir, process.cwd()).dbPath
  }

  return join(Global.Path.banyan.data, `banyancode${channelSuffix()}.db`)
}

/**
 * Bind a Database.Service to the canonical per-root banyancode DB file.
 * Mirrors `layerFromPath` but derives the filename from an EXPLICIT root
 * (realpath hash + installation-channel suffix, same derivation as
 * `WorkspaceIdentity.identityForRoot`), so a repo/indexer bound through this
 * layer reads and writes the SAME file the codegraph build writes to —
 * regardless of `process.cwd()` at server start. The caller-supplied root
 * must exist (or be creatable); use `WorkspaceIdentity.identityForRoot` for
 * validation at API boundaries.
 */
export function layerFromRoot(root: string) {
  // findContainingBanyanDir walks up for an existing `.banyancode` marker and
  // deliberately skips a marker sitting at the filesystem root, so a polluted
  // drive-root marker never hijacks child projects. Fall back to the
  // root-local `.banyancode` when no (non-root) marker exists.
  const banyanDir = findContainingBanyanDir(root) ?? join(root, ".banyancode")
  return layerFromPath(deriveBanyanDbPath(banyanDir, root).dbPath)
}

export const defaultLayer = Layer.unwrap(
  Effect.gen(function* () {
    return layerFromPath(path())
  }),
).pipe(Layer.provide(Global.defaultLayer))

export const node = LayerNode.make(layerFromPath(path()), [])

export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Cause, Context, Effect, Layer } from "effect"
import { classifySqliteError } from "effect/unstable/sql/SqlError"
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

// Shared open sequence: process PRAGMAs + apply migrations on the drizzle db
// built over the `#sqlite` layer (provided by the caller via `sqliteLayer`).
// Every layer entry point funnels through here so corruption quarantine/rebuild
// applies uniformly. `filename` identifies the DB file — the `#sqlite` layer
// binds it and the quarantine path in `layerFromPath` consults it.
const open = (filename: string) =>
  Effect.gen(function* () {
    void filename
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return db
  })

// SQLITE_CORRUPT ("database disk image is malformed") and SQLITE_NOTADB
// ("file is not a database" / "not a database") message markers.
const CORRUPT_MARKERS = ["database disk image is malformed", "file is not a database", "not a database"] as const

const hasCorruptionMarker = (text: string): boolean => {
  const lower = text.toLowerCase()
  return CORRUPT_MARKERS.some((marker) => lower.includes(marker))
}

// Walk an error's message/reason/cause chain looking for corruption markers.
// `classifySqliteError` (below) normalizes native driver causes by reading
// `.code`/`.errno`; SQLITE_CORRUPT (11) / SQLITE_NOTADB (26) classify as
// UnknownError whose `.cause` preserves the native message, so the message
// chain is the deciding signal. The `seen` set guards cyclic cause chains.
const corruptionSignals = (value: unknown, seen: Set<unknown>): boolean => {
  if (!value || typeof value !== "object" || seen.has(value)) return false
  seen.add(value)
  const record = value as Record<string, unknown>
  if (typeof record.message === "string" && hasCorruptionMarker(record.message)) return true
  if (record.reason && typeof record.reason === "object" && corruptionSignals(record.reason, seen)) return true
  if (record.cause && typeof record.cause === "object" && corruptionSignals(record.cause, seen)) return true
  return false
}

const isCorruptionError = (cause: Cause.Cause<unknown>): boolean => {
  for (const reason of cause.reasons) {
    if (reason._tag === "Interrupt") continue
    const value = reason._tag === "Die" ? reason.defect : reason.error
    // Structured classification first, then the message chain on both the raw
    // value and the normalized reason (they share the native cause).
    const classified = classifySqliteError(value)
    if (corruptionSignals(classified, new Set()) || corruptionSignals(value, new Set())) return true
  }
  return false
}

const isQuarantinable = (filename: string): boolean =>
  filename !== ":memory:" && filename !== "" && !filename.startsWith("file:")

const QUARANTINE_RETRIES = 20

// Rename the DB file and its -wal/-shm siblings (when present) to
// `<name>.corrupt-<epochMs>` so the next open creates a fresh database. The
// rename is retried briefly because the failed client may still hold the file
// open for a few ms after its scope closes (Windows EBUSY).
const quarantineCorruptDatabase = (filename: string): Effect.Effect<string[], never> =>
  Effect.gen(function* () {
    const stamp = `corrupt-${Date.now()}`
    const renamed: string[] = []
    for (const suffix of ["", "-wal", "-shm"] as const) {
      const target = `${filename}${suffix}`
      const dest = `${target}.${stamp}`
      for (let attempt = 0; attempt < QUARANTINE_RETRIES; attempt++) {
        const result = yield* Effect.sync(() => {
          if (!fs.existsSync(target)) return "missing" as const
          try {
            fs.renameSync(target, dest)
            return "renamed" as const
          } catch {
            return "locked" as const
          }
        })
        if (result === "renamed") {
          renamed.push(dest)
          break
        }
        if (result === "missing") break
        yield* Effect.sleep("25 millis")
      }
    }
    return renamed
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* open("")
    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  const build = () => layer.pipe(Layer.provide(sqliteLayer({ filename })))
  return build().pipe(
    Layer.catchCause((cause) => {
      if (isQuarantinable(filename) && isCorruptionError(cause)) {
        // Quarantine the corrupt file, then rebuild the same layer fresh so the
        // next open lands on a pristine path. `Layer.unwrap` runs the
        // quarantine effect before the replacement layer builds, and
        // `Layer.fresh` gives the rebuild its own memoMap so a failed first
        // build (memoized under the shared layer identity) is not reused.
        return Layer.unwrap(
          Effect.gen(function* () {
            const renamed = yield* quarantineCorruptDatabase(filename)
            yield* Effect.logWarning("corrupt database quarantined; rebuilding", { path: filename, renamed })
            return Layer.fresh(build())
          }),
        )
      }
      return Layer.effect(Service, Effect.die(Cause.squash(cause)))
    }),
  )
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

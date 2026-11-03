/**
 * `banyancode db gc` — v1 collected orphaned per-worktree databases from a
 * project's `.banyancode/` directory. v2's plugin keeps one database per
 * project under `<data>/projects/` (`banyancode-<sha256(root)[0..12]>.db`),
 * so the collector scans that directory instead and deletes only families
 * whose project no longer exists on disk.
 *
 * Classification (v1 semantics: dry-run by default, the current project always
 * protected, foreign files never touched):
 *
 *   current                 this worktree, canonical name         → protected
 *   other-channel-current   this worktree, legacy `-<channel>`    → protected
 *   live project            indexed_root still exists on disk     → kept
 *   orphan                  indexed_root is gone / hash mismatch  → deletable
 *   unknown                 no meta row, unreadable database     → kept
 *   foreign                 not a banyancode-<12 hex> name        → never deleted
 *
 * Every channel now shares the canonical file, so `current` is the plain
 * `banyancode-<hash>.db` regardless of the installed channel or env. Legacy
 * per-channel files are still parsed and reported, but they are user data until
 * `Storage.open` adopts one, so they are protected rather than orphaned.
 */
import { createHash } from "node:crypto"
import { existsSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { Effect, Option } from "effect"
import { Global } from "@opencode/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { onError } from "./client"
import { println, Style } from "./ui"

const BANYAN_TAGGED_DB = /^banyancode-([0-9a-f]{12})(-.*)?\.db$/

export type DbFamilyClass = "current" | "other-channel-current" | "live" | "orphan" | "unknown" | "foreign"

export interface DbFamily {
  readonly name: string
  readonly classification: DbFamilyClass
  readonly bytes: number
  /** Root recorded in the database's `codegraph_meta` row, when readable. */
  readonly indexedRoot?: string
}

export interface ClassifiedListing {
  readonly directory: string
  readonly currentTag: string
  readonly families: DbFamily[]
}

export const shortHash = (input: string) => createHash("sha256").update(input).digest("hex").slice(0, 12)

export const canonicalRoot = (input: string) => {
  try {
    return realpathSync.native(input)
  } catch {
    return resolve(input)
  }
}

/**
 * Legacy, always `""`. Every channel resolves to the canonical
 * `banyancode-<hash>.db`, so no suffix is ever appended. Kept exported (and with
 * the old parameters) because callers build the current filename from it and
 * because `classifyName` needs a definition of "the current suffix"; legacy
 * `banyancode-<hash>-<channel>.db` files are recognized by the tag parser, not
 * by this function.
 */
export const channelSuffix = (_channel?: string, _env: NodeJS.ProcessEnv = process.env) => ""

export const projectsDirectory = (env = process.env) => {
  const override = env.BANYANCODE_PROJECT_DB_DIR?.trim() || env.OPENCODE_PROJECT_DB_DIR?.trim()
  return override && override.length > 0 ? override : join(Global.Path.data, "projects")
}

const familyBytes = (directory: string, name: string) => {
  let total = 0
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(join(directory, `${name}${suffix}`)).size
    } catch {
      // sibling missing; contributes nothing
    }
  }
  return total
}

type Reader = { all: (sql: string) => ReadonlyArray<Record<string, unknown>>; close: () => void }

async function openReadonly(file: string): Promise<Reader | undefined> {
  try {
    if (typeof Bun !== "undefined") {
      const { Database } = await import("bun:sqlite")
      const db = new Database(file, { readonly: true })
      return {
        all: (sql) => db.query(sql).all() as ReadonlyArray<Record<string, unknown>>,
        // close(true) finalizes outstanding statements; without it Windows keeps
        // the file handle open and a later unlink fails with EBUSY.
        close: () => db.close(true),
      }
    }
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(file, { readOnly: true })
    return {
      all: (sql) => db.prepare(sql).all() as ReadonlyArray<Record<string, unknown>>,
      close: () => db.close(),
    }
  } catch {
    return undefined
  }
}

export async function readIndexedRoot(file: string): Promise<string | undefined> {
  const db = await openReadonly(file)
  if (!db) return undefined
  try {
    const rows = db.all("SELECT indexed_root FROM codegraph_meta LIMIT 1")
    const value = rows[0]?.indexed_root
    return typeof value === "string" && value.length > 0 ? value : undefined
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

export function classifyName(
  name: string,
  currentTag: string,
  indexedRoot: string | undefined,
  currentSuffix = channelSuffix(),
): DbFamilyClass {
  const tagged = BANYAN_TAGGED_DB.exec(name)
  if (!tagged) return "foreign"
  if (tagged[1] === currentTag) return (tagged[2] ?? "") === currentSuffix ? "current" : "other-channel-current"
  if (indexedRoot === undefined) return "unknown"
  // Trust the recorded root only when it hashes to the file's tag.
  if (shortHash(canonicalRoot(indexedRoot)) !== tagged[1]) return "unknown"
  return existsSync(indexedRoot) ? "live" : "orphan"
}

export async function scanProjectsDir(directory: string, root: string): Promise<ClassifiedListing> {
  const currentTag = shortHash(canonicalRoot(root))
  let names: string[] = []
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".db"))
  } catch {
    return { directory, currentTag, families: [] }
  }
  const families = await Promise.all(
    names.map(async (name): Promise<DbFamily> => {
      const indexedRoot = BANYAN_TAGGED_DB.test(name) ? await readIndexedRoot(join(directory, name)) : undefined
      return {
        name,
        classification: classifyName(name, currentTag, indexedRoot),
        bytes: familyBytes(directory, name),
        ...(indexedRoot === undefined ? {} : { indexedRoot }),
      }
    }),
  )
  return { directory, currentTag, families }
}

export const orphanFamilies = (listing: ClassifiedListing) =>
  listing.families.filter((family) => family.classification === "orphan")

export const orphanBytes = (listing: ClassifiedListing) =>
  orphanFamilies(listing).reduce((total, family) => total + family.bytes, 0)

export interface GcResult {
  readonly deleted: string[]
  readonly reclaimedBytes: number
}

export function deleteOrphans(directory: string, orphans: ReadonlyArray<DbFamily>): GcResult {
  const deleted: string[] = []
  let reclaimedBytes = 0
  for (const family of orphans) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = join(directory, `${family.name}${suffix}`)
      try {
        const size = statSync(target).size
        unlinkSync(target)
        reclaimedBytes += size
        deleted.push(`${family.name}${suffix}`)
      } catch {
        // already gone, unreadable, or still locked; skip without claiming bytes
      }
    }
  }
  return { deleted, reclaimedBytes }
}

export const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const label = (classification: DbFamilyClass) => {
  switch (classification) {
    case "current":
      return "current"
    case "other-channel-current":
      return "legacy channel file (protected)"
    case "live":
      return "live project (kept)"
    case "orphan":
      return "orphan"
    case "unknown":
      return "unknown (kept)"
    default:
      return "foreign (never deleted)"
  }
}

export function printListing(listing: ClassifiedListing): void {
  println(Style.TEXT_HIGHLIGHT + `Databases in ${listing.directory}` + Style.TEXT_NORMAL)
  if (listing.families.length === 0) {
    println("  (no .db files)")
    return
  }
  for (const family of listing.families) {
    println(`  ${family.name}  ${formatBytes(family.bytes)}  [${label(family.classification)}]`)
  }
  const orphans = orphanFamilies(listing)
  println("")
  println(`Orphan candidates: ${orphans.length} file(s), ${formatBytes(orphanBytes(listing))}`)
}

/**
 * Core of `db gc`: lists, then deletes orphans only when `yes` is set and
 * `dryRun` is not. `directory` is injectable for tests.
 */
export async function runDbGc(args: {
  yes: boolean
  dryRun?: boolean
  root?: string
  directory?: string
}): Promise<GcResult | undefined> {
  const root = resolve(args.root ?? process.cwd())
  const directory = args.directory ?? projectsDirectory()
  if (!existsSync(directory)) {
    println(`No project database directory at ${directory}; nothing to collect.`)
    return undefined
  }
  const listing = await scanProjectsDir(directory, root)
  printListing(listing)
  const orphans = orphanFamilies(listing)
  if (orphans.length === 0) {
    println("Nothing to delete.")
    return undefined
  }
  if (args.dryRun === true || !args.yes) {
    println("")
    println("Dry run: nothing deleted. Re-run with `--yes` to delete the orphans above.")
    println("The current project's database is always protected, and legacy per-channel files are kept until adopted.")
    return undefined
  }
  const { deleted, reclaimedBytes } = deleteOrphans(directory, orphans)
  println("")
  println(
    Style.TEXT_SUCCESS + `Deleted ${deleted.length} file(s), reclaimed ${formatBytes(reclaimedBytes)}.` + Style.TEXT_NORMAL,
  )
  return { deleted, reclaimedBytes }
}

const handler = Effect.fn("cli.db.gc")(function* (
  input: Runtime.Input<(typeof Commands.commands.db.commands)["gc"]>,
) {
  yield* Effect.promise(() =>
    runDbGc({
      yes: input.yes,
      dryRun: Option.getOrUndefined(input.dryRun),
      root: Option.getOrUndefined(input.root),
    }),
  )
})

export default Runtime.handler(Commands.commands.db.commands.gc, (input) =>
  handler(input).pipe(Effect.catch(onError())),
)

import type { Argv } from "yargs"
import { Effect } from "effect"
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { channelSuffix, findContainingBanyanDir, sanitizeRoot, shortHash } from "@opencode-ai/core/database/banyan-db-path"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"

export const STALE_DB_HINT_THRESHOLD_BYTES = 500 * 1024 * 1024

const BANYAN_TAGGED_DB = /^banyancode-([0-9a-f]{12})(-.*)?\.db$/
const LEGACY_DB = /^banyancode(-[A-Za-z0-9._-]+)?\.db$/

export type DbFamilyClass = "current" | "other-channel-current" | "orphan" | "foreign"

export interface DbFamily {
  /** Base filename without directory, e.g. `banyancode-3abae43a0c41-dev.db`. */
  readonly name: string
  readonly classification: DbFamilyClass
  /** Total bytes across the `.db` file plus existing `-wal`/`-shm` siblings. */
  readonly bytes: number
}

export interface ClassifiedListing {
  readonly banyanDir: string
  readonly currentTag: string
  readonly families: DbFamily[]
}

const legacyDbPath = (): boolean =>
  process.env.BANYANCODE_LEGACY_DB_PATH === "1" || process.env.BANYANCODE_LEGACY_DB_PATH === "true"

const classifyName = (
  name: string,
  currentTag: string,
  opts: { legacy: boolean; legacyCurrentName?: string },
): DbFamilyClass => {
  const tagged = BANYAN_TAGGED_DB.exec(name)
  if (tagged) {
    if (tagged[1] === currentTag) {
      return tagged[2] ? "other-channel-current" : "current"
    }
    return "orphan"
  }
  if (LEGACY_DB.test(name)) {
    // In legacy mode the exact un-hashed current filename belongs to this
    // worktree and must never be collected. Outside legacy mode all
    // un-hashed names are legacy leftovers (e.g. `banyancode-main.db`), and
    // branch-named files are orphan candidates in either mode.
    if (opts.legacy && name === opts.legacyCurrentName) return "current"
    return "orphan"
  }
  return "foreign"
}

const familyBytes = (banyanDir: string, name: string): number => {
  let total = 0
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(join(banyanDir, `${name}${suffix}`)).size
    } catch {
      // sibling missing; contributes nothing
    }
  }
  return total
}

/**
 * Stat-only scan of a `.banyancode/` directory. Reads no file contents, so
 * it is cheap enough to run at startup for the stale-DB hint.
 */
export const scanBanyanDir = (banyanDir: string, root: string): ClassifiedListing => {
  const legacy = legacyDbPath()
  const currentTag = legacy ? "" : shortHash(sanitizeRoot(root))
  const legacyCurrentName = legacy ? `banyancode${channelSuffix()}.db` : undefined
  let names: string[] = []
  try {
    names = readdirSync(banyanDir).filter((name) => name.endsWith(".db"))
  } catch {
    return { banyanDir, currentTag, families: [] }
  }
  const families = names.map((name): DbFamily => {
    const classification = classifyName(name, currentTag, { legacy, legacyCurrentName })
    return { name, classification, bytes: familyBytes(banyanDir, name) }
  })
  return { banyanDir, currentTag, families }
}

export const orphanFamilies = (listing: ClassifiedListing): DbFamily[] =>
  listing.families.filter((family) => family.classification === "orphan")

export const orphanBytes = (listing: ClassifiedListing): number =>
  orphanFamilies(listing).reduce((total, family) => total + family.bytes, 0)

/**
 * Startup-hint helper: returns the hint string when orphan candidates exceed
 * the threshold, undefined otherwise. Stat-only, never throws.
 */
export const staleDbHint = (cwd: string): string | undefined => {
  try {
    const banyanDir = findContainingBanyanDir(cwd)
    if (!banyanDir) return undefined
    const listing = scanBanyanDir(banyanDir, cwd)
    const bytes = orphanBytes(listing)
    if (bytes <= STALE_DB_HINT_THRESHOLD_BYTES) return undefined
    const gb = (bytes / 1024 ** 3).toFixed(1)
    return (
      `Stale banyancode databases use ~${gb} GB in ${banyanDir}. ` +
      `Run \`banyancode db gc\` to review and reclaim the space.`
    )
  } catch {
    return undefined
  }
}

export interface GcResult {
  readonly deleted: string[]
  readonly reclaimedBytes: number
}

/** Delete orphan families (`.db` plus `-wal`/`-shm` siblings). Protected and foreign files are never touched. */
export const deleteOrphans = (banyanDir: string, orphans: DbFamily[]): GcResult => {
  const deleted: string[] = []
  let reclaimedBytes = 0
  for (const family of orphans) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = join(banyanDir, `${family.name}${suffix}`)
      try {
        reclaimedBytes += statSync(target).size
        unlinkSync(target)
        deleted.push(`${family.name}${suffix}`)
      } catch {
        // already gone or unreadable; skip
      }
    }
  }
  return { deleted, reclaimedBytes }
}

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const printListing = (listing: ClassifiedListing): void => {
  UI.println(UI.Style.TEXT_HIGHLIGHT + `Databases in ${listing.banyanDir}` + UI.Style.TEXT_NORMAL)
  if (listing.families.length === 0) {
    UI.println("  (no .db files)")
    return
  }
  for (const family of listing.families) {
    const label =
      family.classification === "current"
        ? "current"
        : family.classification === "other-channel-current"
          ? "current worktree, other channel (protected)"
          : family.classification === "orphan"
            ? "orphan"
            : "foreign (never deleted)"
    UI.println(`  ${family.name}  ${formatBytes(family.bytes)}  [${label}]`)
  }
  const orphans = orphanFamilies(listing)
  const bytes = orphanBytes(listing)
  UI.println("")
  UI.println(`Orphan candidates: ${orphans.length} file(s), ${formatBytes(bytes)}`)
}

/** Core of `db gc`: lists, then deletes orphans only when `yes` is set and `dryRun` is not. Returns the deletion result, if any. */
export const runDbGc = (args: { yes: boolean; dryRun?: boolean; root?: string }): GcResult | undefined => {
  const root = args.root ?? process.cwd()
  const cwd = resolve(root)
  const banyanDir = findContainingBanyanDir(cwd) ?? join(cwd, ".banyancode")
  if (!existsSync(banyanDir)) {
    UI.println(`No .banyancode directory at ${banyanDir}; nothing to collect.`)
    return undefined
  }
  const listing = scanBanyanDir(banyanDir, cwd)
  printListing(listing)
  const orphans = orphanFamilies(listing)
  if (orphans.length === 0) {
    UI.println("Nothing to delete.")
    return undefined
  }
  if (args.dryRun === true || !args.yes) {
    UI.println("")
    UI.println("Dry run: nothing deleted. Re-run with `--yes` to delete the orphans above.")
    UI.println("The current worktree's databases in every channel are always protected.")
    return undefined
  }
  const { deleted, reclaimedBytes } = deleteOrphans(banyanDir, orphans)
  UI.println("")
  UI.println(
    UI.Style.TEXT_SUCCESS +
      `Deleted ${deleted.length} file(s), reclaimed ${formatBytes(reclaimedBytes)}.` +
      UI.Style.TEXT_NORMAL,
  )
  return { deleted, reclaimedBytes }
}

export const DbGcCommand = effectCmd({
  command: "gc",
  describe: "list orphaned banyancode databases and delete them only with --yes (dry-run by default)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("yes", {
        type: "boolean",
        default: false,
        describe: "actually delete orphaned databases (without this flag nothing is deleted)",
      })
      .option("dry-run", {
        type: "boolean",
        describe: "list what would be deleted without deleting, even with --yes",
      })
      .option("root", {
        type: "string",
        describe: "project root whose worktree hash identifies current databases (defaults to cwd)",
      }),
  handler: Effect.fn("Cli.db.gc")(function* (args: { yes: boolean; "dry-run"?: boolean; root?: string }) {
    runDbGc({ yes: args.yes, dryRun: args["dry-run"], root: args.root })
  }),
})

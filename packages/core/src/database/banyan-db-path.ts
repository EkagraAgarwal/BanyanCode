// Single source of truth for the canonical per-workspace banyancode DB
// filename. `Database.path()` (cwd-keyed, for non-graph services) and
// `WorkspaceIdentity.identityForRoot` (explicit-root-keyed, for the codegraph
// build/read paths) must agree on BOTH the filename hash (realpath of the
// workspace root) AND the installation-channel suffix — otherwise a restart
// from a different cwd or a dev/next vs stable channel can open a different
// SQLite file, making `codegraph_meta` look "missing" even though graph data
// exists. Both callers resolve their own marker `.banyancode` directory and
// then delegate the filename derivation to `deriveBanyanDbPath` below.
//
// Legacy compatibility flags are preserved verbatim from the old
// `Database.path()` behavior:
//   - `BANYANCODE_LEGACY_DB_PATH=1` → un-hashed `banyancode.db` /
//     `banyancode-<channel>.db` filename for one release cycle;
//   - `OPENCODE_DISABLE_CHANNEL_DB=1` → no channel suffix;
//   - `InstallationChannel` ∈ { latest, beta, prod } → no channel suffix;
//   - any other channel (e.g. `dev`, `next`, `local`) → `-<channel>` suffix.

import { createHash } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { InstallationChannel } from "../installation/version"

export const shortHash = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 12)

export const sanitizeRoot = (input: string): string => {
  // Realpath removes 8.3 short-file-name segments and resolves symlinks so
  // two paths that point at the same tree produce the same tag. Falls back
  // to `resolve` when realpath fails (e.g. a root that no longer exists).
  try {
    return realpathSync.native(input)
  } catch {
    return resolve(input)
  }
}

const legacyDbPath = (): boolean =>
  process.env.BANYANCODE_LEGACY_DB_PATH === "1" || process.env.BANYANCODE_LEGACY_DB_PATH === "true"

export const channelSuffix = (): string => {
  const disabled =
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  return disabled ? "" : `-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}`
}

export interface BanyanDbPathDerivation {
  /** Canonical (realpath'd) root used for the hash. */
  readonly canonicalRoot: string
  /** 12-char hash of canonicalRoot; empty in legacy mode. */
  readonly tag: string
  /** Whether the legacy un-hashed filename is in effect. */
  readonly legacy: boolean
  /** Installation-channel suffix including leading dash, or empty. */
  readonly channelSuffix: string
  /** Just the DB filename inside `banyanDir`. */
  readonly filename: string
  /** Full path to the DB file. */
  readonly dbPath: string
}

export const deriveBanyanDbPath = (banyanDir: string, root: string): BanyanDbPathDerivation => {
  const legacy = legacyDbPath()
  const suffix = channelSuffix()
  const canonicalRoot = sanitizeRoot(root)
  const tag = legacy ? "" : shortHash(canonicalRoot)
  const filename = legacy ? `banyancode${suffix}.db` : `banyancode-${tag}${suffix}.db`
  return { canonicalRoot, tag, legacy, channelSuffix: suffix, filename, dbPath: join(banyanDir, filename) }
}

// Walk up from `startDir` looking for an existing `.banyancode` marker
// directory (never creates one). Shared by `Database.path()` /
// `Database.layerFromRoot` and `WorkspaceIdentity.identityForRoot` so a
// build bound to an explicit root and a server started from that root agree
// on the marker directory.
export const findContainingBanyanDir = (startDir: string): string | undefined => {
  let dir = startDir
  while (true) {
    const candidate = join(dir, ".banyancode")
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // missing or unreachable; keep walking
    }
    const parent = resolve(dir, "..")
    if (parent === dir) return undefined
    dir = parent
  }
}

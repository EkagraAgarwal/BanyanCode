export * as WorkspaceIdentity from "./workspace-identity"

import { existsSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { deriveBanyanDbPath, findContainingBanyanDir } from "../database/banyan-db-path"

// Phase 7 follow-up: a pure, synchronous workspace-identity helper that
// derives the canonical codegraph database path from an *explicit root*
// rather than process.cwd(). Database.path() in ../database/database.ts
// still keys on cwd at startup, but the codegraph_build / repository_*
// tools all operate against a root the caller passes explicitly. Anything
// that exposes graph storage to those tools must use THIS helper so the
// diagnostic output (effective DB, graph metadata) reflects the same path
// the repo/indexer services write to.
//
// The filename (hash of the realpath'd root + installation-channel suffix)
// is derived by the shared `deriveBanyanDbPath` helper that `Database.path()`
// also uses, so a build bound to an explicit root and a server started from
// that root (or any channel) open the SAME SQLite file. Without the shared
// derivation, `Database.path()` hashed process.cwd() AND applied the channel
// suffix while this helper hashed the root WITHOUT the suffix — so dev/next
// vs stable installs and restart-from-different-cwd scenarios could open
// different DBs and make `codegraph_meta` look "missing".
//
// The helper also produces a small workspace-identity summary that the
// build status, codegraph repo meta, and the LSP proxy tools all read, so
// out-of-scope queries carry an explicit `root != indexed_root` signal
// instead of silently returning fuzzy-match results.

export const sanitizeRoot = (input: string): string => {
  // Realpath removes 8.3 short-file-name segments and resolves symlinks
  // so two paths that point at the same tree produce the same tag.
  try {
    return realpathSync.native(input)
  } catch {
    return resolve(input)
  }
}

export interface WorkspaceIdentity {
  /** Caller-supplied root, normalized via realpath (or resolve on failure). */
  readonly root: string
  /** Marker directory holding the per-workspace DB (.banyancode). */
  readonly banyanDir: string
  /** Canonical DB filename derived from the root hash + channel suffix, so two workspaces never collide. */
  readonly dbPath: string
  /** Short tag used to build the DB filename. */
  readonly tag: string
}

export const identityForRoot = (rawRoot: string): WorkspaceIdentity => {
  if (!rawRoot) {
    throw new Error("WorkspaceIdentity.identityForRoot: root must be a non-empty path")
  }
  const root = sanitizeRoot(rawRoot)
  if (!existsSync(root)) {
    throw new Error(`WorkspaceIdentity.identityForRoot: root '${rawRoot}' does not exist`)
  }
  // findContainingBanyanDir walks up for an existing `.banyancode` marker and
  // skips a marker sitting at the filesystem root (e.g. `D:\.banyancode`) —
  // that is polluted state, not a workspace marker. Fall back to the
  // root-local `.banyancode` when no (non-root) marker exists.
  const banyanDir = findContainingBanyanDir(root) ?? join(root, ".banyancode")
  const derivation = deriveBanyanDbPath(banyanDir, root)
  return { root, banyanDir, dbPath: derivation.dbPath, tag: derivation.tag }
}

/**
 * Path-style identity for cases where the caller's root escapes the
 * canonical project marker tree. Returns the same shape as identityForRoot
 * but synthesizes a `.banyancode` directory under the explicit root so
 * downstream services can still attach graph storage there.
 */
export const identityForRootStrict = (rawRoot: string): WorkspaceIdentity => {
  const base = identityForRoot(rawRoot)
  // If the canonical directory already exists, nothing more to do.
  try {
    if (statSync(base.banyanDir).isDirectory()) return base
  } catch {
    // fall through to mkdir
  }
  // Best-effort mkdir; never throw on read-only checkouts — let later
  // service access surface any I/O error.
  try {
    require("node:fs").mkdirSync(base.banyanDir, { recursive: true })
  } catch {
    // ignore; dbPath will still be returned so diagnostics can carry it
  }
  return base
}

export const isInsideWorkspace = (root: string, candidate: string): boolean => {
  if (!candidate) return false
  try {
    const rootAbs = sanitizeRoot(root)
    const candAbs = sanitizeRoot(candidate)
    const rel = relative(rootAbs, candAbs)
    if (rel === "") return true
    if (rel.startsWith("..")) return false
    if (isAbsolute(rel)) return false
    return true
  } catch {
    return false
  }
}

export const diagnosisFromMeta = (
  identity: WorkspaceIdentity,
  meta: { indexedRoot?: string | undefined; totalFiles?: number; totalNodes?: number; totalEdges?: number; graphVersion?: number } | undefined,
):
  | { status: "no-graph" }
  | { status: "in-scope"; indexedRoot: string }
  | { status: "out-of-scope"; indexedRoot: string } => {
  if (!meta?.indexedRoot) return { status: "no-graph" }
  if (meta.indexedRoot === identity.root) {
    return { status: "in-scope", indexedRoot: meta.indexedRoot }
  }
  return { status: "out-of-scope", indexedRoot: meta.indexedRoot }
}

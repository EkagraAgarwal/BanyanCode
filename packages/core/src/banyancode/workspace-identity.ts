export * as WorkspaceIdentity from "./workspace-identity"

import { createHash } from "node:crypto"
import { existsSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

// Phase 7 follow-up: a pure, synchronous workspace-identity helper that
// derives the canonical codegraph database path from an *explicit root*
// rather than process.cwd(). Database.path() in ../database/database.ts
// still keys on cwd at startup, but the codegraph_build / repository_*
// tools all operate against a root the caller passes explicitly. Anything
// that exposes graph storage to those tools must use THIS helper so the
// diagnostic output (effective DB, graph metadata) reflects the same path
// the repo/indexer services write to.
//
// The helper also produces a small workspace-identity summary that the
// build status, codegraph repo meta, and the LSP proxy tools all read, so
// out-of-scope queries carry an explicit `root != indexed_root` signal
// instead of silently returning fuzzy-match results.

const WORKSPACE_MARKERS = [".git", "banyancode.json", "opencode.json", ".banyancode", ".opencode"]

export const sanitizeRoot = (input: string): string => {
  // Realpath removes 8.3 short-file-name segments and resolves symlinks
  // so two paths that point at the same tree produce the same tag.
  try {
    return realpathSync.native(input)
  } catch {
    return resolve(input)
  }
}

const shortHash = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 12)

const findContainingProjectDir = (root: string): string | undefined => {
  let dir = root
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

export interface WorkspaceIdentity {
  /** Caller-supplied root, normalized via realpath (or resolve on failure). */
  readonly root: string
  /** Marker directory holding the per-workspace DB (.banyancode). */
  readonly banyanDir: string
  /** Canonical DB filename derived from the root hash, so two workspaces never collide. */
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
  const banyanDir = findContainingProjectDir(root) ?? join(root, ".banyancode")
  const tag = shortHash(root)
  const dbPath = join(banyanDir, `banyancode-${tag}.db`)
  return { root, banyanDir, dbPath, tag }
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

/**
 * Pure, synchronous workspace-identity helpers.
 *
 * Ported from v1 `packages/core/src/banyancode/workspace-identity.ts`.
 *
 * v2 difference: the plugin owns exactly one SQLite file per project
 * (`<project>/.banyancode/banyancode-<hash>.db`, resolved by the storage
 * service), so this module no longer derives a database path from the root.
 * `identityForRoot` keeps the root / banyan-directory pair for diagnostics,
 * and the canonical-root helpers are shared by the indexer, readiness and
 * tools exactly as in v1.
 */
import { existsSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

export const sanitizeRoot = (input: string): string => {
  try {
    return realpathSync.native(input)
  } catch {
    return resolve(input)
  }
}

export interface WorkspaceIdentity {
  /** Caller-supplied root, normalized via realpath (or resolve on failure). */
  readonly root: string
  /** Marker directory holding the per-workspace data (`.banyancode`). */
  readonly banyanDir: string
}

export const identityForRoot = (rawRoot: string): WorkspaceIdentity => {
  if (!rawRoot) {
    throw new Error("WorkspaceIdentity.identityForRoot: root must be a non-empty path")
  }
  const root = sanitizeRoot(rawRoot)
  if (!existsSync(root)) {
    throw new Error(`WorkspaceIdentity.identityForRoot: root '${rawRoot}' does not exist`)
  }
  return { root, banyanDir: join(root, ".banyancode") }
}

export const canonicalizeRoot = (input: string): string => {
  const real = sanitizeRoot(input)
  return process.platform === "win32" ? real.replace(/\//g, "\\").toLowerCase() : real
}

/** True when `child` is `parent` or lives underneath it. */
export const isWithinRoot = (child: string, parent: string): boolean => {
  const rel = relative(canonicalizeRoot(parent), canonicalizeRoot(child))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const samePath = (a: string, b: string): boolean =>
  process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)

const isAncestor = (candidate: string, descendant: string): boolean => {
  const rel = relative(resolve(candidate), resolve(descendant))
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/** The home folder and those above it hold far more than one project, so they are never indexed unasked. */
export const isHomeOrAbove = (root: string, home: string = homedir()): boolean =>
  samePath(resolve(root), home) || isAncestor(resolve(root), home)

export type ProjectRootResolution =
  | { readonly _tag: "Ok"; readonly root: string }
  | { readonly _tag: "Refused"; readonly message: string }

/**
 * Resolve a codegraph root against the open project.
 *
 * The plugin stores every project's graph in that project's own database, so a
 * build must never index a folder outside it: doing so replaces the project's
 * graph with another folder's files. An omitted root means the project root;
 * a relative or absolute path is accepted only when it stays inside it.
 */
export const resolveProjectRoot = (projectRoot: string, requested?: string): ProjectRootResolution => {
  const base = sanitizeRoot(projectRoot)
  if (requested === undefined || requested.trim() === "") return { _tag: "Ok", root: base }
  const candidate = isAbsolute(requested) ? requested : resolve(base, requested)
  const root = sanitizeRoot(candidate)
  if (!existsSync(root)) {
    return { _tag: "Refused", message: `root '${requested}' does not exist` }
  }
  try {
    if (!statSync(root).isDirectory()) {
      return { _tag: "Refused", message: `root '${requested}' is not a directory` }
    }
  } catch {
    return { _tag: "Refused", message: `root '${requested}' is not accessible` }
  }
  if (!isWithinRoot(root, base)) {
    return {
      _tag: "Refused",
      message: `root '${requested}' is outside the open project ('${base}'); the code graph only indexes the open project`,
    }
  }
  if (isHomeOrAbove(root)) {
    return {
      _tag: "Refused",
      message: `root '${requested}' is the user home directory or above; open a project directory instead`,
    }
  }
  return { _tag: "Ok", root }
}

export const isInsideWorkspace = (root: string, candidate: string): boolean => {
  if (!candidate) return false
  try {
    const rel = relative(sanitizeRoot(root), sanitizeRoot(candidate))
    if (rel === "") return true
    if (rel.startsWith("..")) return false
    return !isAbsolute(rel)
  } catch {
    return false
  }
}

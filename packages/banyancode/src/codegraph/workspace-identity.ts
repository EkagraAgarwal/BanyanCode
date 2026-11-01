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
import { isAbsolute, join, parse, relative, resolve } from "node:path"

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

export type EffectiveRootSource = "explicit" | "worktree" | "repo-walk" | "cwd"

export type EffectiveRoot =
  | { readonly _tag: "Ok"; readonly root: string; readonly source: EffectiveRootSource }
  | { readonly _tag: "InvalidWorkspace"; readonly diagnostic: { readonly kind: string; readonly message: string } }

const invalid = (message: string): EffectiveRoot => ({
  _tag: "InvalidWorkspace",
  diagnostic: { kind: "invalid-workspace", message },
})

const samePath = (a: string, b: string): boolean =>
  process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)

const isAncestor = (candidate: string, descendant: string): boolean => {
  const rel = relative(resolve(candidate), resolve(descendant))
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/** The home directory (or any ancestor) is never a project root. */
export const findRepoRoot = (startDir: string, home: string = homedir()): string | undefined => {
  const dir = resolve(startDir)
  const { root: fsRoot } = parse(dir)
  const walk = (marker: string, isMarker: (p: string) => boolean): string | undefined => {
    let current = dir
    while (current !== fsRoot && !samePath(current, home) && !isAncestor(current, home)) {
      if (isMarker(join(current, marker))) return current
      current = resolve(current, "..")
    }
    return undefined
  }
  return (
    walk(".git", (p) => {
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    }) ??
    walk("package.json", (p) => {
      try {
        return statSync(p).isFile()
      } catch {
        return false
      }
    })
  )
}

export const resolveEffectiveRoot = (input: {
  readonly explicitRoot?: string | undefined
  readonly worktree?: string | undefined
  readonly cwd?: string | undefined
  readonly home?: string | undefined
}): EffectiveRoot => {
  const cwd = input.cwd ?? process.cwd()
  const home = input.home ?? homedir()
  const repoRoot = findRepoRoot(cwd, home)
  const candidate = input.explicitRoot ?? input.worktree ?? repoRoot ?? cwd
  const source: EffectiveRootSource = input.explicitRoot
    ? "explicit"
    : input.worktree
      ? "worktree"
      : repoRoot !== undefined && candidate !== cwd
        ? "repo-walk"
        : "cwd"
  if (!candidate || candidate.trim() === "") return invalid("workspace root must be a non-empty path")
  const root = sanitizeRoot(candidate)
  const { root: fsRoot } = parse(root)
  if (root === fsRoot)
    return invalid(`workspace root '${candidate}' resolves to a filesystem root; pass a workspace directory instead`)
  if (samePath(root, home)) {
    return invalid(`workspace root '${candidate}' is the user home directory; open a project directory instead`)
  }
  try {
    if (!existsSync(root)) return invalid(`workspace root '${candidate}' does not exist`)
    if (!statSync(root).isDirectory()) return invalid(`workspace root '${candidate}' is not a directory`)
  } catch {
    return invalid(`workspace root '${candidate}' is not accessible`)
  }
  return { _tag: "Ok", root, source }
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

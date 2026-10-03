// Per-task git worktree isolation (Milestone C2, gap-plan §4.5).
//
// Plain async module (node stdlib only, no Effect runtime — same constraint
// as task-engine.ts). Each task that opts into `isolation: "worktree"` gets
// its own `git worktree add` checkout; the task's SDK calls then run with
// `directory` set to the worktree path, so two parallel worktree tasks can
// modify the same relative file without conflict.
//
// Lifecycle contract (gap-plan §4.5 + C2 acceptance):
// - allocate() creates the worktree (branch `banyan-mcp/<name>`) under
//   `<root>/.banyancode/mcp-worktrees/<name>` and tracks it in-memory.
// - A second allocate() for a name that is already allocated (or whose
//   directory already exists on disk) is rejected with a
//   WorktreeConflictError that names a free alternative to use.
// - release() removes ONLY clean worktrees (`git status --porcelain`
//   empty). Dirty worktrees (modified, staged, or untracked files) are
//   preserved so no agent output is ever deleted automatically.
// - Paths this manager did not allocate are never deleted.

import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import * as path from "node:path"
import { mkdir } from "node:fs/promises"

export interface WorktreeAllocation {
  name: string
  directory: string
  branch: string
}

export type WorktreeReleaseDisposition = "removed" | "preserved-dirty"

export interface WorktreeManager {
  allocate(input?: { name?: string }): Promise<WorktreeAllocation>
  release(directory: string): Promise<WorktreeReleaseDisposition>
  isClean(directory: string): Promise<boolean>
  allocated(): WorktreeAllocation[]
}

export interface WorktreeManagerOptions {
  // Parent directory for worktree checkouts. Defaults to
  // `<root>/.banyancode/mcp-worktrees`.
  worktreesDir?: string
}

export class WorktreeConflictError extends Error {
  readonly code = "WORKTREE_IN_USE" as const
  readonly suggestion: string
  constructor(directory: string, suggestion: string) {
    super(
      `worktree "${directory}" is already allocated to a running task; retry with a different worktree name, e.g. "${suggestion}"`,
    )
    this.suggestion = suggestion
  }
}

const BRANCH_PREFIX = "banyan-mcp/" as const
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

// Sanitize a caller-provided name to the git-safe charset; returns undefined
// when nothing usable remains so the caller falls back to a generated name.
export function sanitizeWorktreeName(name: string): string | undefined {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  if (!NAME_PATTERN.test(cleaned)) return undefined
  return cleaned
}

function runGit(args: string[], cwd: string): Promise<{ code: number; text: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error && typeof (error as { code?: unknown }).code !== "number") {
        reject(error)
        return
      }
      const code = typeof (error as { code?: unknown } | null)?.code === "number"
        ? ((error as { code: number }).code)
        : 0
      resolve({ code, text: String(stdout), stderr: String(stderr) })
    })
  })
}

async function listWorktreePaths(root: string): Promise<Set<string>> {
  const listed = await runGit(["worktree", "list", "--porcelain"], root)
  if (listed.code !== 0) throw new Error(`git worktree list failed: ${listed.stderr || listed.text}`)
  const paths = new Set<string>()
  for (const line of listed.text.split("\n")) {
    if (line.startsWith("worktree ")) paths.add(path.resolve(line.slice("worktree ".length).trim()))
  }
  return paths
}

export function createGitWorktreeManager(root: string, opts: WorktreeManagerOptions = {}): WorktreeManager {
  const resolvedRoot = path.resolve(root)
  const parent = opts.worktreesDir !== undefined ? path.resolve(opts.worktreesDir) : path.join(resolvedRoot, ".banyancode", "mcp-worktrees")
  const byDirectory = new Map<string, WorktreeAllocation>()

  const suggestFreeName = (base: string): string => {
    for (let attempt = 2; attempt < 1000; attempt++) {
      const candidate = `${base}-${attempt}`.slice(0, 40)
      const dir = path.join(parent, candidate)
      if (!byDirectory.has(dir)) return candidate
    }
    return `mcp-${randomBytes(4).toString("hex")}`
  }

  const allocate: WorktreeManager["allocate"] = async (input = {}) => {
    // Fail closed on the enclosing repository: the root must BE a worktree
    // top-level, not merely sit under one. Ancestor discovery would
    // otherwise allocate MCP checkouts into an unrelated parent repo
    // (e.g. a home-directory dotfiles repo above a tmp dir).
    const top = await runGit(["rev-parse", "--show-toplevel"], resolvedRoot)
    const fold = (s: string): string => (process.platform === "win32" ? s.toLowerCase() : s)
    if (top.code !== 0 || fold(path.resolve(top.text.trim())) !== fold(resolvedRoot)) {
      throw new Error(
        `worktree isolation needs a git repository rooted at ${resolvedRoot} (${top.stderr || top.text || "not a worktree top-level"})`,
      )
    }
    await mkdir(parent, { recursive: true })
    const base = (input.name !== undefined ? sanitizeWorktreeName(input.name) : undefined) ?? `mcp-${randomBytes(4).toString("hex")}`
    const directory = path.join(parent, base)
    if (byDirectory.has(directory)) {
      throw new WorktreeConflictError(directory, suggestFreeName(base))
    }
    const existing = await listWorktreePaths(resolvedRoot).catch(() => new Set<string>())
    if (existing.has(path.resolve(directory))) {
      throw new WorktreeConflictError(directory, suggestFreeName(base))
    }
    const branch = `${BRANCH_PREFIX}${base}`
    // A stale branch from a previous crashed run would fail `worktree add
    // -b`; check first so the error names the fix instead of git's output.
    const refCheck = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], resolvedRoot)
    const branchName = refCheck.code === 0 ? `${branch}-${randomBytes(4).toString("hex")}` : branch
    const finalDir = refCheck.code === 0 ? path.join(parent, `${base}-${branchName.slice(-8)}`) : directory
    if (byDirectory.has(finalDir)) throw new WorktreeConflictError(finalDir, suggestFreeName(base))
    const added = await runGit(["worktree", "add", "-b", branchName, finalDir, "HEAD"], resolvedRoot)
    if (added.code !== 0) {
      throw new Error(`git worktree add failed for ${finalDir}: ${added.stderr || added.text}`)
    }
    const allocation: WorktreeAllocation = { name: path.basename(finalDir), directory: finalDir, branch: branchName }
    byDirectory.set(finalDir, allocation)
    return allocation
  }

  const isClean: WorktreeManager["isClean"] = async (directory) => {
    const status = await runGit(["status", "--porcelain"], path.resolve(directory))
    if (status.code !== 0) throw new Error(`git status failed in ${directory}: ${status.stderr || status.text}`)
    return status.text.trim().length === 0
  }

  const release: WorktreeManager["release"] = async (directory) => {
    const resolved = path.resolve(directory)
    const known = byDirectory.get(resolved)
    if (!known) {
      // Never delete what this manager did not allocate: absent from the
      // git list means nothing to do; present-but-foreign stays untouched.
      const listed = await listWorktreePaths(resolvedRoot).catch(() => new Set<string>())
      return listed.has(resolved) ? "preserved-dirty" : "removed"
    }
    let clean: boolean
    try {
      clean = await isClean(resolved)
    } catch {
      // Fail-closed: when cleanliness cannot be determined, preserve.
      return "preserved-dirty"
    }
    if (!clean) {
      byDirectory.delete(resolved)
      return "preserved-dirty"
    }
    // Clean: remove the checkout, then drop the branch. Best-effort on the
    // branch (a concurrent `git worktree prune` may have beaten us to it).
    byDirectory.delete(resolved)
    const removed = await runGit(["worktree", "remove", "--force", resolved], resolvedRoot)
    if (removed.code !== 0) {
      const listed = await listWorktreePaths(resolvedRoot).catch(() => new Set<string>())
      if (listed.has(resolved)) {
        byDirectory.set(resolved, known)
        throw new Error(`git worktree remove failed for ${resolved}: ${removed.stderr || removed.text}`)
      }
    }
    await runGit(["branch", "-D", known.branch], resolvedRoot).catch(() => ({ code: 0, text: "", stderr: "" }))
    return "removed"
  }

  const allocated: WorktreeManager["allocated"] = () => [...byDirectory.values()]

  return { allocate, release, isClean, allocated }
}

export * as McpTaskWorktree from "./worktree"

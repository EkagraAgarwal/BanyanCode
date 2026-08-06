/**
 * Canonical workspace-root resolution shared by every codegraph/repository
 * tool execution path.
 *
 * Phase 1 of the codegraph-tool-reliability plan makes the selected
 * instance/worktree — not `process.cwd()` — the canonical graph root.
 * Resolution precedence:
 *   1. an explicit tool input (root / workspace / projectRoot);
 *   2. the session `WorktreeContext` (wired from the instance worktree);
 *   3. `process.cwd()` (or an explicit `cwdFallback`);
 *   4. repo-root discovery (`.git` / `package.json` walk-up) as the final
 *      compatibility fallback so a nested cwd inside a monorepo worktree
 *      still resolves to the workspace root.
 *
 * Consumers must NOT read `process.cwd()` directly in tool bodies — that is
 * what made slash commands, agent calls, status, and the TUI observe
 * different roots.
 */
import { Effect } from "effect"
import { existsSync } from "node:fs"
import path from "path"
import { WorktreeContext } from "./worktree-context"

export type WorkspaceRootInput = {
  /** Explicit tool input (root / workspace / projectRoot). Highest precedence. */
  readonly explicit?: string | undefined
  /** Optional override for the `process.cwd()` compatibility fallback. */
  readonly cwdFallback?: string | undefined
}

const findRepoRoot = (startDir: string): string | undefined => {
  let dir = path.resolve(startDir)
  const { root: fsRoot } = path.parse(dir)

  // First pass: look specifically for .git to find the true workspace/monorepo root
  let current = dir
  while (current !== fsRoot) {
    if (existsSync(path.join(current, ".git"))) {
      return current
    }
    current = path.dirname(current)
  }

  // Second pass: fallback to package.json if not a git repository
  current = dir
  while (current !== fsRoot) {
    if (existsSync(path.join(current, "package.json"))) {
      return current
    }
    current = path.dirname(current)
  }

  return undefined
}

export const resolveWorkspaceRoot = (
  input: WorkspaceRootInput = {},
): Effect.Effect<string, never, never> =>
  Effect.gen(function* () {
    if (input.explicit) return path.resolve(input.explicit)
    const readWorktree = yield* WorktreeContext
    const worktree = yield* readWorktree()
    if (worktree) return path.resolve(worktree)
    const fallback = input.cwdFallback ?? process.cwd()
    const repoRoot = findRepoRoot(fallback)
    if (repoRoot) return path.resolve(repoRoot)
    return path.resolve(fallback)
  })

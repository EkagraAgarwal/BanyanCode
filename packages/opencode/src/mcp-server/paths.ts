// The one realpath-aware project-root guard for the MCP server.
//
// Replaces the three lexical copies (server.ts `assertInsideRoot`,
// tools-code.ts `isInsideRoot`, isolation.ts `isInsideRoot`), which used
// `path.resolve`/`relative` only: a symlink inside the root pointing
// outside passed the check, and Windows case variants could compare
// unequal. This guard realpaths both sides (realpathing the nearest
// existing ancestor when the target does not exist yet) and compares
// case-insensitively on win32.

import path from "node:path"
import { existsSync, realpathSync } from "node:fs"

const isWin32 = process.platform === "win32"

// Realpath a path that may not exist yet: walk up to the nearest existing
// ancestor, realpath that, then re-append the remainder lexically.
const realpathLoose = (resolved: string): string => {
  try {
    return realpathSync(resolved)
  } catch {
    let current = resolved
    const rest: Array<string> = []
    for (;;) {
      const parent = path.dirname(current)
      if (parent === current) return resolved
      rest.unshift(path.basename(current))
      if (existsSync(parent)) {
        try {
          return path.join(realpathSync(parent), ...rest)
        } catch {
          return resolved
        }
      }
      current = parent
    }
  }
}

const realRoot = (root: string): string => {
  const resolved = path.resolve(root)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

// Throws when `input` resolves outside `root`. Returns the absolute,
// realpath-resolved path so callers forward one canonical form to the
// server (which resolves against its own base, not the MCP `--cwd`).
export const assertInsideRoot = (root: string, input: string): string => {
  const base = realRoot(root)
  const target = realpathLoose(path.resolve(root, input))
  const lhs = isWin32 ? base.toLowerCase() : base
  const rhs = isWin32 ? target.toLowerCase() : target
  const relative = path.relative(lhs, rhs)
  if (relative === "") return target
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes project root: ${input}`)
  }
  return target
}

// Pure boolean form of the guard for validation-only call sites.
export const isInsideRoot = (root: string, input: string): boolean => {
  try {
    assertInsideRoot(root, input)
    return true
  } catch {
    return false
  }
}

export * as McpPaths from "./paths"

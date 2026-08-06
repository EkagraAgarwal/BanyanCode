/**
 * Path predicates shared by the codegraph and repository-intelligence layers.
 *
 * Lives in `banyancode/` so the indexer, resolver, repo, and intel layer can
 * all classify a file path consistently without importing the tool-layer
 * regex arrays (which would reverse the core → tools dependency direction).
 *
 * The predicate deliberately matches `.test.` / `.spec.` filename suffixes
 * (anchored at end-of-path) and the `__tests__/` directory marker rather
 * than a substring `includes("test")` — so a file legitimately named
 * `src/suffix-test.ts` (a fixture in `codegraph-service-tags.test.ts:162`)
 * is NOT falsely classified as a test file.
 */
import { Effect } from "effect"
import type { Interface as CodegraphRepoInterface } from "./codegraph-repo"
import type { CodegraphFile } from "./types"

export const isTestFilePath = (input: string): boolean => {
  if (!input) return false
  // Windows paths come in as `D:\OpenCode\packages\...`; normalize to forward slashes
  // so the regex anchors (which use `/`) match consistently across platforms.
  const path = input.replace(/\\/g, "/")
  if (/\.test\.[^./]+$/.test(path)) return true
  if (/\.spec\.[^./]+$/.test(path)) return true
  if (/(^|\/)__tests__\//.test(path)) return true
  if (/(^|\/)(tests?)\/[^/]+\.(go|py|pyw)$/.test(path)) return true
  return false
}

// Normalize a caller-provided path against the indexed graph's root so
// the same input resolves whether the user typed an absolute Windows
// path, a path with backslashes, or a clean repo-relative path.
//
// NOTE: The original `normalizePathForLookup` only stripped the indexed
// root from absolute inputs and relied on `getFileByPath`'s exact match
// against the stored form. In practice the graph stores ABSOLUTE paths on
// Windows (`D:\OpenCode\packages\core\…`), so the stripped relative form
// never matched. The `resolveFileByPath` flow tries multiple candidate
// forms (exact, root-prefixed, root-suffixed) before falling back to a
// single suffix match so the call works for legacy relative rows and
// current absolute rows alike.
//
// Moved here from repository-intelligence/layer.ts (Phase 2 of the
// codegraph-tool-reliability plan) so repo-map detail, code_find,
// repository intelligence, and raw codegraph file queries all share the
// same resolution semantics.
export const buildPathCandidates = (input: string, indexedRoot?: string): string[] => {
  const raw = input.trim()
  if (!raw) return []
  // `getFileByPath` exact-matches the stored string, and stored rows keep
  // the platform separator (`D:\OpenCode\packages\…` on Windows). Produce
  // every spelling of the input — raw, forward-slash, backslash — so exact
  // matches work against POSIX and Windows rows alike.
  const noDotSlash = raw.startsWith("./") || raw.startsWith(".\\") ? raw.slice(2) : raw
  const forward = noDotSlash.replace(/\\/g, "/")
  const backslash = noDotSlash.replace(/\//g, "\\")
  const root = indexedRoot ? indexedRoot.trim().replace(/[\\/]+$/, "") : undefined
  const out: string[] = []
  out.push(raw)
  if (forward !== raw) out.push(forward)
  if (backslash !== raw && backslash !== forward) out.push(backslash)
  if (root) {
    const rootForward = root.replace(/\\/g, "/")
    const rootBackslash = root.replace(/\//g, "\\")
    const isBareRoot = forward === rootForward || backslash === rootBackslash
    const underRoot = forward.startsWith(rootForward + "/") || backslash.startsWith(rootBackslash + "\\")
    if (!isBareRoot && !underRoot) {
      // Root-prefixed forms covering every (root separator × path separator)
      // combination. The Windows-backslash combination exactly matches rows
      // stored by a Windows indexer without a full-table suffix scan.
      out.push(`${rootForward}/${forward}`)
      out.push(`${rootForward}\\${forward}`)
      out.push(`${rootBackslash}/${forward}`)
      out.push(`${rootBackslash}\\${forward}`)
      out.push(`${rootBackslash}\\${backslash}`)
    } else if (isBareRoot) {
      out.push("")
    } else if (forward.startsWith(rootForward + "/")) {
      out.push(forward.slice(rootForward.length + 1))
    } else if (backslash.startsWith(rootBackslash + "\\")) {
      out.push(backslash.slice(rootBackslash.length + 1))
    }
  }
  return [...new Set(out)]
}

export const resolveFileByPath = (
  repo: CodegraphRepoInterface,
  input: string,
  indexedRoot: string | undefined,
): Effect.Effect<CodegraphFile | undefined, never, never> =>
  Effect.gen(function* () {
    const candidates = buildPathCandidates(input, indexedRoot)
    for (const candidate of candidates) {
      if (!candidate) continue
      const file = yield* repo.getFileByPath(candidate)
      if (file) return file
    }
    // Suffix fallback: only if exactly one match (avoid picking an arbitrary
    // file when two absolute paths end with the same suffix).
    const allFiles = yield* repo.listAllFiles()
    const normInput = input.replace(/\\/g, "/").replace(/^\.\//, "")
    const matches = allFiles.filter((f: CodegraphFile) => {
      const p = f.path.replace(/\\/g, "/")
      return p === normInput || p.endsWith("/" + normInput) || p.endsWith(normInput)
    })
    if (matches.length === 1) return matches[0]
    return undefined
  })

/**
 * Repo-relative display path for a stored `codegraph_files.path` row.
 *
 * Stored paths are absolute on Windows and after the indexer migration;
 * relative for legacy rows. This strips the indexed root when present,
 * slash-normalizes, and strips a leading `./`, so callers can render
 * stable `packages/core/src/...`-style paths regardless of storage form.
 */
export const toRepoRelativePath = (storedPath: string, indexedRoot?: string): string => {
  const cleaned = storedPath.replace(/\\/g, "/").replace(/^\.\//, "")
  if (!indexedRoot) return cleaned
  const root = indexedRoot.replace(/\\/g, "/").replace(/\/+$/, "")
  if (cleaned === root) return ""
  if (cleaned.startsWith(root + "/")) return cleaned.slice(root.length + 1)
  return cleaned
}

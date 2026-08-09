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

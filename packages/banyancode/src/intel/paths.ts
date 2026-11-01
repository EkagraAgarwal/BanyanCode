/**
 * Path predicates shared by the intel pipeline. Ported from v1
 * `packages/core/src/banyancode/codegraph-paths.ts`.
 */

export const isTestFilePath = (input: string): boolean => {
  if (!input) return false
  const path = input.replace(/\\/g, "/")
  if (/\.test\.[^./]+$/.test(path)) return true
  if (/\.spec\.[^./]+$/.test(path)) return true
  if (/(^|\/)__tests__\//.test(path)) return true
  if (/(^|\/)(tests?)\/[^/]+\.(go|py|pyw)$/.test(path)) return true
  return false
}

const DOC_PATH_PATTERNS = [/\.md$/i, /^readme/i, /^changelog/i, /^contributing/i, /\/docs?\//i, /^design/i]
const CONFIG_PATH_PATTERNS = [
  /package\.json$/i,
  /tsconfig.*\.json$/i,
  /pyproject\.toml$/i,
  /cargo\.toml$/i,
  /go\.mod$/i,
  /pnpm-workspace\.yaml$/i,
  /bun\.fig\.toml$/i,
]

export const isDocPath = (path: string): boolean => DOC_PATH_PATTERNS.some((re) => re.test(path))
export const isConfigPath = (path: string): boolean => CONFIG_PATH_PATTERNS.some((re) => re.test(path))

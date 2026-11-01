/**
 * Ported from v1 `packages/core/src/banyancode/codegraph-helpers.ts`.
 * Extracts bare module names from a test file's import statements so the
 * indexer can emit `tested_by` edges by filename.
 */
export const extractTestFileImports = (code: string): Set<string> => {
  const imports = new Set<string>()
  for (const m of code.matchAll(/import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?["']([^"']+)["']/g)) {
    const spec = m[1]
    if (!spec) continue
    const tail = spec.split("/").pop()
    if (tail) imports.add(tail.replace(/\.(ts|tsx|js|jsx)$/, ""))
  }
  return imports
}

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

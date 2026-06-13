import type { ParseResult, ParsedNode, ParsedEdge } from "./types"

const FROM_IMPORT_REGEX = /from\s+(["'])([^"']+)\1\s+import\s+/g
const IMPORT_REGEX = /^import\s+(?:\{[^}]*\}|\w+|\*\s+as\s+\w+)\s+from\s+(["'])([^"']+)\2/gm
const CLASS_REGEX = /(?:^|\n)class\s+(\w+)(?:\s*\(\s*(\w+)\s*\))?/g
const DEF_REGEX = /(?:^|\n)def\s+(\w+)\s*\(/g

export function parsePython(content: string, fileID: string): ParseResult {
  const nodes: ParsedNode[] = []
  const edges: ParsedEdge[] = []
  const imports: string[] = []

  const addNode = (kind: ParsedNode["kind"], name: string, startLine: number, endLine: number) => {
    nodes.push({ id: `${fileID}:${kind}:${name}:${startLine}`, kind, name, startLine, endLine })
  }

  for (const match of content.matchAll(FROM_IMPORT_REGEX)) {
    imports.push(match[2])
  }

  for (const match of content.matchAll(IMPORT_REGEX)) {
    imports.push(match[3])
  }

  for (const match of content.matchAll(CLASS_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("class", name, startLine, endLine)
  }

  for (const match of content.matchAll(DEF_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("function", name, startLine, endLine)
  }

  return { nodes, edges, imports }
}
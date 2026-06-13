import type { ParseResult, ParsedNode } from "./types"

const FUNCTION_REGEX = /(?:^|\n)(?:export\s+)?function\s+(\w+)\s*\(/g
const CLASS_REGEX = /(?:^|\n)(?:export\s+)?class\s+(\w+)/g

export function parseGeneric(content: string, fileID: string): ParseResult {
  const nodes: ParsedNode[] = []

  const addNode = (kind: ParsedNode["kind"], name: string, startLine: number, endLine: number) => {
    nodes.push({ id: `${fileID}:${kind}:${name}:${startLine}`, kind, name, startLine, endLine })
  }

  for (const match of content.matchAll(FUNCTION_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("function", name, startLine, endLine)
  }

  for (const match of content.matchAll(CLASS_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("class", name, startLine, endLine)
  }

  return { nodes, edges: [], imports: [] }
}
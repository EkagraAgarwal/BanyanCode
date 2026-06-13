import type { ParseResult, ParsedNode, ParsedEdge } from "./types"

const IMPORTS_REGEX = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?["']([^"']+)["']/g
const EXPORT_CLASS_REGEX = /export\s+class\s+(\w+)(?:\s+extends\s+(\w+))?/g
const CLASS_REGEX = /(?:^|\n)(?!export\s+)class\s+(\w+)(?:\s+extends\s+(\w+))?/g
const FUNCTION_REGEX = /(?:^|\n)(?:export\s+)?function\s+(\w+)\s*\(/g
const INTERFACE_REGEX = /(?:^|\n)interface\s+(\w+)/g
const TYPE_REGEX = /(?:^|\n)type\s+(\w+)\s*=/g
const EXTENDS_REGEX = /class\s+(\w+)\s+extends\s+(\w+)/g
const CALL_REGEX = /\b(\w+)\.(\w+)\s*\(/g

export function parseTypeScript(content: string, fileID: string): ParseResult {
  const nodes: ParsedNode[] = []
  const edges: ParsedEdge[] = []
  const imports: string[] = []
  const lines = content.split("\n")

  const addNode = (kind: ParsedNode["kind"], name: string, startLine: number, endLine: number, signature?: string) => {
    nodes.push({ id: `${fileID}:${kind}:${name}:${startLine}`, kind, name, startLine, endLine, signature })
  }

  for (const match of content.matchAll(IMPORTS_REGEX)) {
    imports.push(match[1])
  }

  for (const match of content.matchAll(EXPORT_CLASS_REGEX)) {
    const name = match[1]
    const superClass = match[2]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("class", name, startLine, endLine)
  }

  for (const match of content.matchAll(CLASS_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("class", name, startLine, endLine)
  }

  for (const match of content.matchAll(FUNCTION_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("function", name, startLine, endLine, match[0].trim())
  }

  for (const match of content.matchAll(INTERFACE_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("type", name, startLine, endLine)
  }

  for (const match of content.matchAll(TYPE_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("type", name, startLine, endLine)
  }

  return { nodes, edges, imports }
}
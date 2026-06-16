import type { ParseResult, ParsedNode } from "./types"

const FUNCTION_REGEX = /(?:^|\n)(?:export\s+)?function\s+(\w+)\s*\(/g
const CLASS_REGEX = /(?:^|\n)(?:export\s+)?class\s+(\w+)/g

function simpleHash(content: string): string {
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(16)
}

export function parseGeneric(content: string, fileID: string, filePath: string, language: string): ParseResult {
  const nodes: ParsedNode[] = []

  const addNode = (kind: ParsedNode["kind"], name: string, startLine: number, endLine: number, code?: string) => {
    const relativePath = filePath.replace(/\\\\/g, "/")
    const qualifiedName = relativePath + "::" + name
    const textExcerpt = code ?? ""
    nodes.push({
      id: fileID + ":" + kind + ":" + name + ":" + startLine,
      kind,
      name,
      qualifiedName,
      startLine,
      startByte: 0,
      endLine,
      endByte: 0,
      language,
      textExcerpt,
      nodeCodeHash: simpleHash(textExcerpt),
      code,
    })
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

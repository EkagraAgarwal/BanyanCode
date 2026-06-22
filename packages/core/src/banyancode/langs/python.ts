import type { ParseResult, ParsedNode, ParsedEdge } from "./types"

const FROM_IMPORT_REGEX = /from\s+(["'])([^"']+)\1\s+import\s+/g
const IMPORT_REGEX = /^import\s+(?:\{[^}]*\}|\w+|\*\s+as\s+\w+)\s+from\s+(["'])([^"']+)\2/gm
const CLASS_REGEX = /(?:^|\n)class\s+(\w+)(?:\s*\(\s*(\w+)\s*\))?/g
const DEF_REGEX = /(?:^|\n)def\s+(\w+)\s*\(/g

function getPythonNodeBody(content: string, matchIndex: number, matchText: string): { code: string; endLine: number } {
  const startLine = content.substring(0, matchIndex).split("\n").length
  const lines = content.substring(matchIndex).split("\n")
  
  const declLine = lines[0]
  const indentMatch = declLine.match(/^(\s*)/)
  const declIndent = indentMatch ? indentMatch[1].length : 0
  
  let endIdx = 1
  let blockIndent: number | null = null
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) {
      endIdx = i + 1
      continue
    }
    const lineIndent = line.match(/^(\s*)/)?.[1].length ?? 0
    if (blockIndent === null) {
      if (lineIndent > declIndent) {
        blockIndent = lineIndent
        endIdx = i + 1
      } else {
        break
      }
    } else {
      if (lineIndent >= blockIndent || lineIndent > declIndent) {
        endIdx = i + 1
      } else {
        break
      }
    }
  }
  const codeLines = lines.slice(0, endIdx)
  const code = codeLines.join("\n")
  const endLine = startLine + codeLines.length - 1
  return { code, endLine }
}

export function parsePython(content: string, fileID: string): ParseResult {
  const nodes: ParsedNode[] = []
  const edges: ParsedEdge[] = []
  const imports: string[] = []

  for (const match of content.matchAll(FROM_IMPORT_REGEX)) {
    imports.push(match[2])
  }

  for (const match of content.matchAll(IMPORT_REGEX)) {
    imports.push(match[3])
  }

  for (const match of content.matchAll(CLASS_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const { code, endLine } = getPythonNodeBody(content, match.index, match[0])
    nodes.push({ id: `${fileID}:class:${name}:${startLine}`, kind: "class", name, startLine, endLine, code })
  }

  for (const match of content.matchAll(DEF_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const { code, endLine } = getPythonNodeBody(content, match.index, match[0])
    nodes.push({ id: `${fileID}:function:${name}:${startLine}`, kind: "function", name, startLine, endLine, code })
  }

  return { nodes, edges, imports }
}
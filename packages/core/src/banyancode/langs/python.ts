import type { ParseResult, ParsedNode, ParsedEdge } from "./types"

const FROM_IMPORT_REGEX = /from\s+(["'])([^"']+)\1\s+import\s+/g
const IMPORT_REGEX = /^import\s+(?:\{[^}]*\}|\w+|\*\s+as\s+\w+)\s+from\s+(["'])([^"']+)\2/gm
const CLASS_REGEX = /(?:^|\n)class\s+(\w+)(?:\s*\(\s*(\w+)\s*\))?/g
const DEF_REGEX = /(?:^|\n)def\s+(\w+)\s*\(/g

function computeLineStartOffsets(content: string): number[] {
  const offsets = [0]
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") offsets.push(i + 1)
  }
  return offsets
}

// Equivalent to `content.substring(0, offset).split("\n").length`: the count
// of line starts at or before `offset`. A "\n" exactly AT `offset` is NOT
// counted because `substring(0, offset)` excludes the char at `offset`.
function lineAtOffset(offsets: readonly number[], offset: number): number {
  let lo = 0
  let hi = offsets.length - 1
  let count = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] <= offset) {
      count = mid + 1
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return count
}

function getPythonNodeBody(content: string, matchIndex: number, startLine: number): { code: string; endLine: number } {
  let nextNewline = content.indexOf("\n", matchIndex)
  const declLine = nextNewline === -1 ? content.substring(matchIndex) : content.substring(matchIndex, nextNewline)
  const indentMatch = declLine.match(/^(\s*)/)
  const declIndent = indentMatch ? indentMatch[1].length : 0

  let endOffset = nextNewline === -1 ? content.length : nextNewline
  let lineCount = 1
  let blockIndent: number | null = null

  while (nextNewline !== -1) {
    const lineStart = nextNewline + 1
    const lineEndNewline = content.indexOf("\n", lineStart)
    const lineEnd = lineEndNewline === -1 ? content.length : lineEndNewline
    const line = content.substring(lineStart, lineEnd)
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) {
      endOffset = lineEnd
      lineCount++
    } else {
      const lineIndent = line.match(/^(\s*)/)?.[1].length ?? 0
      if (blockIndent === null) {
        if (lineIndent > declIndent) {
          blockIndent = lineIndent
          endOffset = lineEnd
          lineCount++
        } else {
          break
        }
      } else {
        if (lineIndent >= blockIndent || lineIndent > declIndent) {
          endOffset = lineEnd
          lineCount++
        } else {
          break
        }
      }
    }
    nextNewline = lineEndNewline
  }

  const code = content.substring(matchIndex, endOffset)
  const endLine = startLine + lineCount - 1
  return { code, endLine }
}

export function parsePython(content: string, fileID: string): ParseResult {
  const nodes: ParsedNode[] = []
  const edges: ParsedEdge[] = []
  const offsets = computeLineStartOffsets(content)

  for (const match of content.matchAll(FROM_IMPORT_REGEX)) {
    const symbol = match[2]
    if (!symbol) continue
    edges.push({
      id: `${fileID}:import:${symbol}`,
      fromNodeID: `${fileID}:file`,
      toNodeID: `module:${symbol}`,
      kind: "imports",
    })
  }

  for (const match of content.matchAll(IMPORT_REGEX)) {
    const symbol = match[3]
    if (!symbol) continue
    edges.push({
      id: `${fileID}:import:${symbol}`,
      fromNodeID: `${fileID}:file`,
      toNodeID: `module:${symbol}`,
      kind: "imports",
    })
  }

  for (const match of content.matchAll(CLASS_REGEX)) {
    const name = match[1]
    const startLine = lineAtOffset(offsets, match.index)
    const { code, endLine } = getPythonNodeBody(content, match.index, startLine)
    nodes.push({ id: `${fileID}:class:${name}:${startLine}`, kind: "class", name, startLine, endLine, code })
  }

  for (const match of content.matchAll(DEF_REGEX)) {
    const name = match[1]
    const startLine = lineAtOffset(offsets, match.index)
    const { code, endLine } = getPythonNodeBody(content, match.index, startLine)
    nodes.push({ id: `${fileID}:function:${name}:${startLine}`, kind: "function", name, startLine, endLine, code })
  }

  return { nodes, edges }
}
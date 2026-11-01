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

// First non-whitespace char at/after the match start. The `(?:^|\n)` anchor
// (plus any whitespace between it and the keyword) can sit one or more
// lines before the `def`/`class`, so the declaration line is the line of
// this index — 1-based, matching tree-sitter's `startPosition.row + 1`
// (the line of the `def` keyword). The parser-mode remap in
// codegraph-indexer keys tree-sitter `:function:<line>` endpoints off this
// line, so a skew here silently drops every parser-owned edge.
function declIndexAt(content: string, matchIndex: number): number {
  let i = matchIndex
  while (i < content.length && /\s/.test(content[i]!)) i++
  return i
}

function declStartLine(content: string, offsets: readonly number[], matchIndex: number): number {
  return lineAtOffset(offsets, declIndexAt(content, matchIndex))
}

// Body-extraction budget for getPythonNodeBody: stop extending the captured
// block past 16KB or 2048 lines so a def whose body never dedents (or trails
// in blank/comment lines) can't scan the rest of the file.
const PY_BODY_CHAR_BOUND = 16384
const PY_BODY_LINE_BOUND = 2048

// Same set as JS `\s`: leading-whitespace scans must agree with the regex
// indent measurement and `trim()` emptiness check they replace.
function isPyWs(ch: string): boolean {
  return (
    ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\v" || ch === "\f" ||
    ch === "\u00a0" || ch === "\u1680" ||
    (ch >= "\u2000" && ch <= "\u200a") ||
    ch === "\u2028" || ch === "\u2029" || ch === "\u202f" || ch === "\u205f" || ch === "\u3000" || ch === "\ufeff"
  )
}

function leadingWsLen(content: string, from: number, to: number): number {
  let n = 0
  while (from + n < to && isPyWs(content[from + n]!)) n++
  return n
}

function getPythonNodeBody(
  content: string,
  offsets: readonly number[],
  matchIndex: number,
): { code: string; endLine: number } {
  // Scan the signature's newline from the DECLARATION, not the anchor: the
  // `(?:^|\n)` anchor matches the newline BEFORE the `def`, so scanning from
  // matchIndex finds the anchor itself and captures an empty body for every
  // def that is not at the very start of the file.
  const declIndex = declIndexAt(content, matchIndex)
  let nextNewline = content.indexOf("\n", declIndex)
  const declIndent = leadingWsLen(content, declIndex, nextNewline === -1 ? content.length : nextNewline)

  const startOffset = matchIndex
  let endOffset = nextNewline === -1 ? content.length : nextNewline
  let lineCount = 1
  let blockIndent: number | null = null

  while (nextNewline !== -1 && endOffset - startOffset < PY_BODY_CHAR_BOUND && lineCount < PY_BODY_LINE_BOUND) {
    const lineStart = nextNewline + 1
    const lineEndNewline = content.indexOf("\n", lineStart)
    const lineEnd = lineEndNewline === -1 ? content.length : lineEndNewline
    const indent = leadingWsLen(content, lineStart, lineEnd)
    const firstCode = lineStart + indent
    if (firstCode === lineEnd || content[firstCode] === "#") {
      endOffset = lineEnd
      lineCount++
    } else if (blockIndent === null) {
      if (indent > declIndent) {
        blockIndent = indent
        endOffset = lineEnd
        lineCount++
      } else break
    } else if (indent >= blockIndent || indent > declIndent) {
      endOffset = lineEnd
      lineCount++
    } else break
    nextNewline = lineEndNewline
  }

  const code = content.substring(matchIndex, endOffset)
  // End line = 1-based line of the last captured char (`endOffset` is
  // exclusive), independent of where the anchor sits.
  const endLine = lineAtOffset(offsets, endOffset - 1)
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
    const startLine = declStartLine(content, offsets, match.index)
    const { code, endLine } = getPythonNodeBody(content, offsets, match.index)
    nodes.push({ id: `${fileID}:class:${name}:${startLine}`, kind: "class", name, startLine, endLine, code })
  }

  for (const match of content.matchAll(DEF_REGEX)) {
    const name = match[1]
    const startLine = declStartLine(content, offsets, match.index)
    const { code, endLine } = getPythonNodeBody(content, offsets, match.index)
    nodes.push({ id: `${fileID}:function:${name}:${startLine}`, kind: "function", name, startLine, endLine, code })
  }

  return { nodes, edges }
}
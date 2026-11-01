import type { ParseResult, ParsedNode } from "./types"

const FUNCTION_REGEX = /(?:^|\n)(?:export\s+|pub\s+)?(?:function|fn|func)\s+(\w+)\s*\(/g
const CLASS_REGEX = /(?:^|\n)(?:export\s+|pub\s+)?class\s+(\w+)/g

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
// matches the newline BEFORE the declaration (or the file start), so the
// declaration line is the 1-based line of this index — matching
// tree-sitter's `startPosition.row + 1` (the line of the `func`/`fn`/
// `function`/`class` keyword). The parser-mode remap in codegraph-indexer
// keys tree-sitter `:function:<line>` endpoints off this line, so a skew
// here silently drops every parser-owned edge.
function declIndexAt(content: string, matchIndex: number): number {
  let i = matchIndex
  while (i < content.length && /\s/.test(content[i]!)) i++
  return i
}

// Body-code extraction bound: cap the captured slice so a giant declaration
// can't copy its whole body into node.code. 4000 chars covers real
// function/class bodies and keeps the derived identifier scan
// (rebuildDerivedGraph) bounded. Same order of magnitude as the file-level
// node's `content.slice(0, 4000)` convention.
const GENERIC_BODY_BOUND = 4000

// Body code for go/rust/java/php/ruby declarations (functions, classes):
// slice from the declaration to the matching close brace (brace-balanced,
// same convention as typescript.ts getTSNodeBody), or a bounded window when
// the brace never closes within it, or the declaration line when the
// declaration has no `{` at all.
function genericNodeBody(
  content: string,
  offsets: readonly number[],
  declIndex: number,
): { code: string; endLine: number } {
  const sliceEnd = Math.min(declIndex + GENERIC_BODY_BOUND, content.length)
  const openBrace = content.indexOf("{", declIndex)
  if (openBrace !== -1 && openBrace < sliceEnd) {
    let braceCount = 1
    let i = openBrace + 1
    while (i < sliceEnd) {
      const ch = content[i]!
      if (ch === "{") braceCount++
      else if (ch === "}") {
        braceCount--
        if (braceCount === 0) {
          const endOffset = i + 1
          return {
            code: content.substring(declIndex, endOffset),
            endLine: lineAtOffset(offsets, endOffset - 1),
          }
        }
      }
      i++
    }
  }
  const lineEnd = content.indexOf("\n", declIndex)
  const endOffset = openBrace === -1 && lineEnd !== -1 ? Math.min(sliceEnd, lineEnd) : sliceEnd
  return {
    code: content.substring(declIndex, endOffset),
    endLine: lineAtOffset(offsets, endOffset - 1),
  }
}

export function parseGeneric(content: string, fileID: string): ParseResult {
  const nodes: ParsedNode[] = []
  const offsets = computeLineStartOffsets(content)

  const addNode = (kind: ParsedNode["kind"], name: string, matchIndex: number) => {
    const declIndex = declIndexAt(content, matchIndex)
    const startLine = lineAtOffset(offsets, declIndex)
    const { code, endLine } = genericNodeBody(content, offsets, declIndex)
    nodes.push({ id: `${fileID}:${kind}:${name}:${startLine}`, kind, name, startLine, endLine, code })
  }

  for (const match of content.matchAll(FUNCTION_REGEX)) {
    addNode("function", match[1]!, match.index)
  }

  for (const match of content.matchAll(CLASS_REGEX)) {
    addNode("class", match[1]!, match.index)
  }

  return { nodes, edges: [] }
}

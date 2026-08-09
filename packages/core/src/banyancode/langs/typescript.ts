import type { ParseResult, ParsedNode, ParsedEdge } from "./types"

const IMPORTS_REGEX = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?["']([^"']+)["']/g
const EXPORT_CLASS_REGEX = /export\s+class\s+(\w+)(?:\s+extends\s+(\w+))?/g
const CLASS_REGEX = /(?:^|\n)(?!export\s+)class\s+(\w+)(?:\s+extends\s+(\w+))?/g
const FUNCTION_REGEX = /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g
// Allow leading whitespace so layer-internal `const start = ...` (4-space indented
// inside `Layer.effect(...)`) is indexed. Previously anchored on `(?:^|\n)const`
// which silently dropped every indented layer const.
const ARROW_CONST_REGEX = /(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*=\s*(async\s+)?(?:\([^)]*\)|[^=>\n]+)\s*=>/g
const FACTORY_EXPORT_REGEX = /(?:^|\n)export\s+const\s+(\w+)\s*=\s*((?:Tool\.define|Layer\.effect|Layer\.succeed|Layer\.scoped|Context\.Service|Context\.Tag|Layer\.mergeAll)(?:<[^>]+>)?)\s*\(/g
// Allow optional `export ` and indentation between the newline and the
// `interface` keyword. Real BanyanCode services use
// `export interface Interface { ... }` as the sibling type of
// `Context.Service<Service, Interface>()`. Previously the anchored
// `(?:^|\n)interface` regex silently skipped these declarations.
const INTERFACE_REGEX = /(?:^|\n)\s*(?:export\s+)?interface\s+(\w+)/g
const TYPE_REGEX = /(?:^|\n)type\s+(\w+)\s*=/g
const EFFECT_FN_REGEX = /Effect\.fn\s*\(\s*["']([^"']+)["']\s*\)/
const EFFECT_FN_CONST_REGEX = /const\s+(\w+)\s*=\s*Effect\.fn\s*\(\s*["']([^"']+)["']\s*\)/g
// Match a single `readonly name(args): ReturnType` member line inside an
// `interface { ... }` block. The Context.Service<Service, Interface>() pattern
// puts all callable members in a sibling interface, so a regex pass on each
// interface body produces the method nodes the analyzer needs. Allow `:`
// before the `(` so signatures like `put: (key: string) => Effect.Effect<void>`
// match (the `:` is required by the TS interface body syntax, not optional).
const INTERFACE_MEMBER_REGEX = /(?:^|\n)\s*(?:readonly\s+)?(\w+)\s*[:\s]\s*\(([^)]*)\)\s*[:=]\s*([^\n;]+)/g

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

// `startLine + code.split("\n").length - 1` without the per-match split: the
// newline count in [matchIndex, endOffset) is `lineAtOffset(endOffset) -
// lineAtOffset(matchIndex)`.
function endLineFor(
  offsets: readonly number[],
  matchIndex: number,
  startLine: number,
  endOffset: number,
): number {
  return startLine + lineAtOffset(offsets, endOffset) - lineAtOffset(offsets, matchIndex)
}

// Forward-scan budgets for body extraction. The opening-brace discovery scan
// stops after 8KB so brace-less generated files (many matches, no `{`/`;`)
// don't degrade to O(n²); the brace-count pass gets 64KB so the largest real
// bodies in this repo (a 64KB `layer` function) still capture their close.
const OPEN_SCAN_BOUND = 8192
const BRACE_SCAN_BOUND = 65536

function getTSNodeBody(
  content: string,
  offsets: readonly number[],
  matchIndex: number,
  matchText: string,
  startLine: number,
): { code: string; endLine: number } {
  const afterMatchIndex = matchIndex + matchText.length
  const openLimit = Math.min(afterMatchIndex + OPEN_SCAN_BOUND, content.length)
  let firstBrace = -1
  let firstSemicolon = -1
  for (let i = afterMatchIndex; i < openLimit; i++) {
    const ch = content[i]!
    if (ch === "{") {
      firstBrace = i
      break
    }
    if (ch === ";") {
      firstSemicolon = i
      break
    }
    if ((ch === "f" && content.startsWith("function ", i)) || (ch === "c" && content.startsWith("class ", i))) {
      break
    }
  }
  if (firstBrace !== -1) {
    const braceLimit = Math.min(firstBrace + BRACE_SCAN_BOUND, content.length)
    let braceCount = 1
    let i = firstBrace + 1
    while (i < braceLimit) {
      const ch = content[i]!
      if (ch === "{") braceCount++
      else if (ch === "}") {
        braceCount--
        if (braceCount === 0) {
          return {
            code: content.substring(matchIndex, i + 1),
            endLine: endLineFor(offsets, matchIndex, startLine, i + 1),
          }
        }
      }
      i++
    }
    return {
      code: content.substring(matchIndex, braceLimit),
      endLine: endLineFor(offsets, matchIndex, startLine, braceLimit),
    }
  }
  const endOffset = firstSemicolon !== -1 ? firstSemicolon + 1 : afterMatchIndex
  return {
    code: content.substring(matchIndex, endOffset),
    endLine: endLineFor(offsets, matchIndex, startLine, endOffset),
  }
}

const CLASS_METHOD_REGEX = /(?:^|\n)\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\s*\{/g

function getArrowBody(
  content: string,
  offsets: readonly number[],
  matchIndex: number,
  matchText: string,
  startLine: number,
): { code: string; endLine: number } {
  const arrowIndex = content.indexOf("=>", matchIndex + matchText.length - 2)
  if (arrowIndex === -1) return getTSNodeBody(content, offsets, matchIndex, matchText, startLine)

  const afterArrow = arrowIndex + 2
  const sliceEnd = Math.min(afterArrow + OPEN_SCAN_BOUND, content.length)
  const slice = content.substring(afterArrow, sliceEnd)
  const rest = slice.trimStart()
  if (rest.startsWith("{")) {
    const braceStart = sliceEnd - rest.length
    return getTSNodeBody(content, offsets, matchIndex, content.substring(matchIndex, braceStart + 1), startLine)
  }

  const lineRel = slice.indexOf("\n")
  const endOffset = lineRel === -1 ? sliceEnd : afterArrow + lineRel
  return {
    code: content.substring(matchIndex, endOffset),
    endLine: endLineFor(offsets, matchIndex, startLine, endOffset),
  }
}

function getFactoryBody(
  content: string,
  offsets: readonly number[],
  matchIndex: number,
  matchText: string,
  startLine: number,
): { code: string; endLine: number } {
  const afterMatchIndex = matchIndex + matchText.length
  const openParen = content.indexOf("(", afterMatchIndex)
  if (openParen === -1) return getTSNodeBody(content, offsets, matchIndex, matchText, startLine)
  const parenLimit = Math.min(openParen + BRACE_SCAN_BOUND, content.length)
  let parenCount = 1
  let i = openParen + 1
  while (i < parenLimit && parenCount > 0) {
    if (content[i] === "(") parenCount++
    else if (content[i] === ")") parenCount--
    i++
  }
  const closeParen = i - 1
  return {
    code: content.substring(matchIndex, closeParen + 1),
    endLine: endLineFor(offsets, matchIndex, startLine, closeParen + 1),
  }
}

function extractClassMethods(classCode: string, classStartLine: number, fileID: string, className: string): ParsedNode[] {
  const methods: ParsedNode[] = []
  const localOffsets = computeLineStartOffsets(classCode)
  for (const match of classCode.matchAll(CLASS_METHOD_REGEX)) {
    const name = match[1]
    if (name === "constructor") continue
    const localStart = lineAtOffset(localOffsets, match.index)
    const startLine = classStartLine + localStart - 1
    const { code, endLine: localEnd } = getTSNodeBody(classCode, localOffsets, match.index!, match[0], localStart)
    const endLine = classStartLine + localEnd - 1
    const effectMatch = code.match(EFFECT_FN_REGEX)
    const signature = effectMatch ? effectMatch[1] : match[0].trim()
    methods.push({
      id: `${fileID}:method:${className}:${name}:${startLine}`,
      kind: "method",
      name,
      startLine,
      endLine,
      signature,
      code,
    })
  }
  return methods
}

// Extract members of an `interface Interface { ... }` block. These become
// callable nodes qualified by the enclosing Context.Service<Service, Interface>
// class so blast_radius / preflight / code_find callers on
// `CodegraphBuildService.start` resolve to a real method graph node instead
// of returning 0 callers against the empty class body.
function extractInterfaceMembers(
  interfaceCode: string,
  interfaceStartLine: number,
  fileID: string,
  interfaceName: string,
): ParsedNode[] {
  const members: ParsedNode[] = []
  const seen = new Set<string>()
  const localOffsets = computeLineStartOffsets(interfaceCode)
  for (const match of interfaceCode.matchAll(INTERFACE_MEMBER_REGEX)) {
    const name = match[1]
    if (!name || name === interfaceName) continue
    const params = match[2] ?? ""
    const returnType = (match[3] ?? "").trim().replace(/\s*\{$/, "")
    const localStart = lineAtOffset(localOffsets, match.index)
    const startLine = interfaceStartLine + localStart - 1
    const signature = `${name}(${params.trim()}): ${returnType}`.replace(/\s+/g, " ").trim()
    // Members live on one line in real BanyanCode code; treat the line range
    // as the same line. Multi-line signatures fall back to a 1-line window
    // until tree-sitter migration lands.
    const endLine = startLine
    const id = `${fileID}:method:${interfaceName}:${name}:${startLine}`
    if (seen.has(id)) continue
    seen.add(id)
    members.push({
      id,
      kind: "method",
      name,
      startLine,
      endLine,
      signature,
    })
  }
  return members
}

// Strip comment and string-literal regions from source text so downstream
// classification (identifier word-scans and `includes("extends ")` /
// `includes(name + "(")` kind heuristics) never fires inside comments or
// strings. Replaced regions become spaces/newlines (never removed entirely)
// so line structure and token boundaries are preserved. Regex-v1 pragmatic
// subset: `//` line comments, `/* */` block comments, `"..."` / `'...'`
// strings, and `` `...` `` template literals (interpolations stripped whole).
export function stripCommentsAndStrings(code: string): string {
  const out: string[] = []
  let i = 0
  let lineComment = false
  let blockComment = false
  let inString: '"' | "'" | "`" | undefined = undefined
  const len = code.length
  while (i < len) {
    const ch = code[i]!
    const next = i + 1 < len ? code[i + 1]! : ""
    if (lineComment) {
      out.push(ch === "\n" ? "\n" : " ")
      if (ch === "\n") lineComment = false
      i++
      continue
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        out.push("  ")
        i += 2
        blockComment = false
        continue
      }
      out.push(ch === "\n" ? "\n" : " ")
      i++
      continue
    }
    if (inString) {
      if (ch === "\\") {
        // Escape sequence: swallow the escaped char too.
        out.push("  ")
        i += 2
        continue
      }
      if (ch === inString) {
        out.push(" ")
        inString = undefined
        i++
        continue
      }
      if (ch === "\n") {
        // Unterminated string — treat the newline as the terminator.
        out.push("\n")
        inString = undefined
        i++
        continue
      }
      out.push(" ")
      i++
      continue
    }
    if (ch === "/" && next === "/") {
      out.push("  ")
      i += 2
      lineComment = true
      continue
    }
    if (ch === "/" && next === "*") {
      out.push("  ")
      i += 2
      blockComment = true
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      out.push(" ")
      inString = ch
      i++
      continue
    }
    out.push(ch)
    i++
  }
  return out.join("")
}

export function parseTypeScript(content: string, fileID: string): ParseResult {
  const nodes: ParsedNode[] = []
  const edges: ParsedEdge[] = []
  const offsets = computeLineStartOffsets(content)

  for (const match of content.matchAll(IMPORTS_REGEX)) {
    const symbol = match[1]
    if (!symbol) continue
    edges.push({
      id: `${fileID}:import:${symbol}`,
      fromNodeID: `${fileID}:file`,
      toNodeID: `module:${symbol}`,
      kind: "imports",
    })
  }

  for (const match of content.matchAll(EXPORT_CLASS_REGEX)) {
    const name = match[1]
    const startLine = lineAtOffset(offsets, match.index)
    const { code, endLine } = getTSNodeBody(content, offsets, match.index, match[0], startLine)
    nodes.push({ id: `${fileID}:class:${name}:${startLine}`, kind: "class", name, startLine, endLine, code })
    nodes.push(...extractClassMethods(code, startLine, fileID, name))
  }

  for (const match of content.matchAll(CLASS_REGEX)) {
    const name = match[1]
    const startLine = lineAtOffset(offsets, match.index)
    const { code, endLine } = getTSNodeBody(content, offsets, match.index, match[0], startLine)
    nodes.push({ id: `${fileID}:class:${name}:${startLine}`, kind: "class", name, startLine, endLine, code })
    nodes.push(...extractClassMethods(code, startLine, fileID, name))
  }

  for (const match of content.matchAll(FUNCTION_REGEX)) {
    const name = match[1]
    const startLine = lineAtOffset(offsets, match.index)
    const { code, endLine } = getTSNodeBody(content, offsets, match.index, match[0], startLine)
    const effectMatch = code.match(EFFECT_FN_REGEX)
    const signature = effectMatch ? effectMatch[1] : match[0].trim()
    nodes.push({ id: `${fileID}:function:${name}:${startLine}`, kind: "function", name, startLine, endLine, signature, code })
  }

  for (const match of content.matchAll(FACTORY_EXPORT_REGEX)) {
    const name = match[1]
    const factoryCall = match[2]
    const signature = factoryCall.replace(/\s*\($/, "")
    const startLine = lineAtOffset(offsets, match.index)
    const { code, endLine } = getFactoryBody(content, offsets, match.index!, match[0], startLine)
    nodes.push({ id: `${fileID}:factory:${name}:${startLine}`, kind: "function", name, startLine, endLine, signature, code })
  }

  for (const match of content.matchAll(ARROW_CONST_REGEX)) {
    const name = match[1]
    const startLine = lineAtOffset(offsets, match.index)
    const { code, endLine } = getArrowBody(content, offsets, match.index!, match[0], startLine)
    const effectMatch = code.match(EFFECT_FN_REGEX)
    const signature = effectMatch ? effectMatch[1] : match[0].trim()
    nodes.push({ id: `${fileID}:function:${name}:${startLine}`, kind: "function", name, startLine, endLine, signature, code })
  }

  for (const match of content.matchAll(EFFECT_FN_CONST_REGEX)) {
    const name = match[1]
    const signature = match[2]
    const startLine = lineAtOffset(offsets, match.index)
    const afterMatchIndex = match.index + match[0].length
    const openLimit = Math.min(afterMatchIndex + OPEN_SCAN_BOUND, content.length)
    let firstBrace = -1
    for (let i = afterMatchIndex; i < openLimit; i++) {
      if (content[i] === "{") {
        firstBrace = i
        break
      }
    }
    let code = match[0]
    let endLine = startLine
    if (firstBrace !== -1) {
      const braceLimit = Math.min(firstBrace + BRACE_SCAN_BOUND, content.length)
      let braceCount = 1
      let i = firstBrace + 1
      while (i < braceLimit) {
        if (content[i] === "{") braceCount++
        else if (content[i] === "}") {
          braceCount--
          if (braceCount === 0) {
            code = content.substring(match.index, i + 1)
            endLine = endLineFor(offsets, match.index, startLine, i + 1)
            break
          }
        }
        i++
      }
      if (code === match[0]) {
        code = content.substring(match.index, braceLimit)
        endLine = endLineFor(offsets, match.index, startLine, braceLimit)
      }
    }
    nodes.push({ id: `${fileID}:function:${name}:${startLine}`, kind: "function", name, startLine, endLine, signature, code })
  }

  for (const match of content.matchAll(INTERFACE_REGEX)) {
    const name = match[1]
    const startLine = lineAtOffset(offsets, match.index)
    const { code, endLine } = getTSNodeBody(content, offsets, match.index, match[0], startLine)
    nodes.push({ id: `${fileID}:type:${name}:${startLine}`, kind: "type", name, startLine, endLine, code })
    nodes.push(...extractInterfaceMembers(code, startLine, fileID, name))
  }

  for (const match of content.matchAll(TYPE_REGEX)) {
    const name = match[1]
    const startLine = lineAtOffset(offsets, match.index)
    const { code, endLine } = getTSNodeBody(content, offsets, match.index, match[0], startLine)
    nodes.push({ id: `${fileID}:type:${name}:${startLine}`, kind: "type", name, startLine, endLine, code })
  }

  return { nodes, edges }
}
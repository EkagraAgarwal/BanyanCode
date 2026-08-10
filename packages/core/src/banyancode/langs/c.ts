import type { ParseResult, ParsedNode, ParsedEdge } from "./types"
import { stripCommentsAndStrings } from "./typescript"

const INCLUDE_REGEX = /(?:^|\n)\s*#\s*include\s*[<"]([^>"]+)[>"]/g
const CLASS_REGEX = /(?:^|\n)\s*(?:template\s*<[^>]*>\s*)?class\s+([A-Za-z_]\w*)(?:\s*:\s*[^{]*)?\s*\{/g
const STRUCT_REGEX = /(?:^|\n)\s*(?:typedef\s+)?(struct|enum|union)(?:\s+class)?\s+([A-Za-z_]\w*)\s*\{/g
const TYPEDEF_ANON_REGEX = /(?:^|\n)\s*typedef\s+(?:struct|enum|union)\s*\{/g
const DEFINE_REGEX = /(?:^|\n)\s*#\s*define\s+([A-Za-z_]\w*)/g

const C_QUALIFIERS =
  "(?:static|inline|extern|virtual|constexpr|consteval|constinit|const|volatile|unsigned|signed|register|thread_local|restrict|mutable|friend|explicit|noreturn|_Noreturn)\\s+"
const C_TYPE_TOKEN = "[A-Za-z_]\\w*(?:::[A-Za-z_]\\w*)?(?:\\s*<[^>]*>)?(?:\\s*[*&]+\\s*|\\s+)"
const C_FN_SUFFIX = "(?:const|noexcept\\s*\\([^)]*\\)|noexcept|override|final|volatile|throw\\s*\\([^)]*\\)|__attribute__\\s*\\([^)]*\\)|\\s)*"
// A definition ends with `{` (a declaration ends with `;` and is dropped). The
// name allows `Foo::bar` qualification for out-of-line C++ methods.
const FUNCTION_DEF_REGEX = new RegExp(
  `(?:^|\\n)\\s*(?:template\\s*<[^>]*>\\s*)?(?:${C_QUALIFIERS})*(?:${C_TYPE_TOKEN})+((?:[A-Za-z_]\\w*::)*[A-Za-z_]\\w*)\\s*\\(([^;{}]*)\\)\\s*${C_FN_SUFFIX}([{;])`,
  "g",
)
const METHOD_REGEX = new RegExp(
  `(?:^|\\n)\\s+(?:${C_QUALIFIERS})*(?:${C_TYPE_TOKEN})*([A-Za-z_]\\w*)\\s*\\(([^;{}]*)\\)\\s*${C_FN_SUFFIX}\\{`,
  "g",
)
const GLOBAL_VAR_REGEX = new RegExp(
  `(?:^|\\n)\\s*(?:${C_QUALIFIERS})*(?:${C_TYPE_TOKEN})+([A-Za-z_]\\w*)\\s*(?:=|\\[|;)`,
  "g",
)

const C_KEYWORDS = new Set([
  "if", "for", "while", "switch", "case", "default", "return", "goto", "do", "else",
  "sizeof", "typeof", "alignof", "typeid", "decltype", "catch", "try", "throw", "delete",
  "new", "using", "namespace", "typedef", "struct", "enum", "union", "class", "template",
  "typename", "static_cast", "dynamic_cast", "const_cast", "reinterpret_cast",
  "static_assert", "alignas", "noexcept", "friend", "explicit", "virtual", "inline",
  "extern", "volatile", "register", "signed", "unsigned", "mutable", "thread_local",
  "restrict", "const", "constexpr", "consteval", "constinit", "operator", "public",
  "private", "protected", "true", "false", "nullptr", "NULL", "std",
])

function computeLineStartOffsets(content: string): number[] {
  const offsets = [0]
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") offsets.push(i + 1)
  }
  return offsets
}

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

function endLineAt(offsets: readonly number[], endOffset: number): number {
  return lineAtOffset(offsets, endOffset - 1)
}

// Index of the declaration proper. The `(?:^|\n)` anchor and any leading
// whitespace can sit one or more lines before the declaration keyword, so the
// first non-whitespace char after the match start carries the true line.
function declIndexAt(content: string, matchIndex: number): number {
  let i = matchIndex
  while (i < content.length && /\s/.test(content[i]!)) i++
  return i
}

// Brace-matching bound: stop extending the captured body past 64KB so an
// unclosed brace can't scan the rest of the file.
const BRACE_SCAN_BOUND = 65536

// Scans from the opening brace (already part of the match) for the matching
// close on the comment/string-stripped source, then re-slices the ORIGINAL
// content at the same offsets (the strip preserves length).
function scanBraceBody(
  content: string,
  stripped: string,
  offsets: readonly number[],
  matchIndex: number,
  braceIndex: number,
): { code: string; endLine: number } {
  const braceLimit = Math.min(braceIndex + BRACE_SCAN_BOUND, stripped.length)
  let braceCount = 1
  let i = braceIndex + 1
  while (i < braceLimit) {
    const ch = stripped[i]!
    if (ch === "{") braceCount++
    else if (ch === "}") {
      braceCount--
      if (braceCount === 0) {
        return {
          code: content.substring(matchIndex, i + 1),
          endLine: endLineAt(offsets, i + 1),
        }
      }
    }
    i++
  }
  return {
    code: content.substring(matchIndex, braceLimit),
    endLine: endLineAt(offsets, braceLimit),
  }
}

// The name bound after a `typedef struct { ... } Name;` closing brace.
function trailingTypeAlias(content: string, closeIndex: number): { name: string; endOffset: number } | undefined {
  const window = content.substring(closeIndex + 1, closeIndex + 257)
  const m = /^\s*([A-Za-z_]\w*)\s*;/.exec(window)
  if (!m) return undefined
  return { name: m[1]!, endOffset: closeIndex + 1 + m.index + m[0].length }
}

function extractClassMethods(
  classCode: string,
  strippedClassCode: string,
  classStartLine: number,
  fileID: string,
  className: string,
): ParsedNode[] {
  const methods: ParsedNode[] = []
  const localOffsets = computeLineStartOffsets(classCode)
  for (const match of classCode.matchAll(METHOD_REGEX)) {
    const name = match[1]
    if (!name || name === className || C_KEYWORDS.has(name)) continue
    if (match[0].trimStart().startsWith("operator")) continue
    const localStart = lineAtOffset(localOffsets, declIndexAt(classCode, match.index))
    const startLine = classStartLine + localStart - 1
    const braceIndex = match.index + match[0].length - 1
    const { code, endLine: localEnd } = scanBraceBody(
      classCode,
      strippedClassCode,
      localOffsets,
      match.index,
      braceIndex,
    )
    const endLine = classStartLine + localEnd - 1
    methods.push({
      id: `${fileID}:method:${className}:${name}:${startLine}`,
      kind: "method",
      name,
      startLine,
      endLine,
      signature: match[0].trim(),
      code,
    })
  }
  return methods
}

export function parseC(content: string, fileID: string): ParseResult {
  const nodes: ParsedNode[] = []
  const edges: ParsedEdge[] = []
  const offsets = computeLineStartOffsets(content)
  const stripped = stripCommentsAndStrings(content)

  for (const match of content.matchAll(INCLUDE_REGEX)) {
    const symbol = match[1]
    if (!symbol) continue
    edges.push({
      id: `${fileID}:include:${symbol}`,
      fromNodeID: `${fileID}:file`,
      toNodeID: `module:${symbol}`,
      kind: "imports",
    })
  }

  // Body ranges of declarations that contain braces; anything declared inside
  // them (indented locals, class members) is not a top-level symbol.
  const bodyRanges: { start: number; end: number }[] = []

  // Classes first: their bodies filter indented function-like matches, and
  // member methods are extracted per class.
  for (const match of content.matchAll(CLASS_REGEX)) {
    const name = match[1]
    const declIndex = declIndexAt(content, match.index)
    const startLine = lineAtOffset(offsets, declIndex)
    const braceIndex = match.index + match[0].length - 1
    const { code, endLine } = scanBraceBody(content, stripped, offsets, declIndex, braceIndex)
    const node: ParsedNode = { id: `${fileID}:class:${name}:${startLine}`, kind: "class", name, startLine, endLine, code }
    nodes.push(node)
    const strippedClassCode = stripped.substring(declIndex, declIndex + code.length)
    nodes.push(...extractClassMethods(code, strippedClassCode, startLine, fileID, name))
    bodyRanges.push({ start: startLine, end: endLine })
  }

  const functionNodes: ParsedNode[] = []
  const seenFunctionIds = new Set<string>()
  for (const match of content.matchAll(FUNCTION_DEF_REGEX)) {
    const qualified = match[1]
    const name = qualified.split("::").pop()!
    if (!name || C_KEYWORDS.has(name)) continue
    if (match[3] !== "{") continue
    const declIndex = declIndexAt(content, match.index)
    const startLine = lineAtOffset(offsets, declIndex)
    if (bodyRanges.some((r) => startLine >= r.start && startLine <= r.end)) continue
    const braceIndex = match.index + match[0].length - 1
    const { code, endLine } = scanBraceBody(content, stripped, offsets, declIndex, braceIndex)
    const id = `${fileID}:function:${name}:${startLine}`
    if (seenFunctionIds.has(id)) continue
    seenFunctionIds.add(id)
    const node: ParsedNode = { id, kind: "function", name, startLine, endLine, signature: match[0].trim(), code }
    functionNodes.push(node)
    nodes.push(node)
    bodyRanges.push({ start: startLine, end: endLine })
  }

  for (const match of content.matchAll(STRUCT_REGEX)) {
    const name = match[2]
    const declIndex = declIndexAt(content, match.index)
    const startLine = lineAtOffset(offsets, declIndex)
    const braceIndex = match.index + match[0].length - 1
    const { code, endLine } = scanBraceBody(content, stripped, offsets, declIndex, braceIndex)
    nodes.push({ id: `${fileID}:type:${name}:${startLine}`, kind: "type", name, startLine, endLine, code })
    bodyRanges.push({ start: startLine, end: endLine })
    if (match[0].trimStart().startsWith("typedef")) {
      const alias = trailingTypeAlias(content, declIndex + code.length - 1)
      if (alias) {
        nodes.push({
          id: `${fileID}:type:${alias.name}:${startLine}`,
          kind: "type",
          name: alias.name,
          startLine,
          endLine: lineAtOffset(offsets, alias.endOffset - 1),
          code,
        })
      }
    }
  }

  for (const match of content.matchAll(TYPEDEF_ANON_REGEX)) {
    const declIndex = declIndexAt(content, match.index)
    const startLine = lineAtOffset(offsets, declIndex)
    const braceIndex = match.index + match[0].length - 1
    const { code, endLine } = scanBraceBody(content, stripped, offsets, declIndex, braceIndex)
    const alias = trailingTypeAlias(content, declIndex + code.length - 1)
    if (!alias) continue
    nodes.push({
      id: `${fileID}:type:${alias.name}:${startLine}`,
      kind: "type",
      name: alias.name,
      startLine,
      endLine: lineAtOffset(offsets, alias.endOffset - 1),
      code,
    })
    bodyRanges.push({ start: startLine, end: endLine })
  }

  for (const match of content.matchAll(DEFINE_REGEX)) {
    const name = match[1]
    const declIndex = declIndexAt(content, match.index)
    const startLine = lineAtOffset(offsets, declIndex)
    const fnLike = content[match.index + match[0].length] === "("
    const lineEnd = content.indexOf("\n", declIndex)
    const code = content.substring(declIndex, lineEnd === -1 ? content.length : lineEnd)
    nodes.push({
      id: `${fileID}:${fnLike ? "function" : "variable"}:${name}:${startLine}`,
      kind: fnLike ? "function" : "variable",
      name,
      startLine,
      endLine: startLine,
      code,
    })
  }

  for (const match of content.matchAll(GLOBAL_VAR_REGEX)) {
    const name = match[1]
    if (!name || C_KEYWORDS.has(name)) continue
    if (/\b(?:using|namespace|typedef|struct|enum|union|class|template|return)\b/.test(match[0])) continue
    const declIndex = declIndexAt(content, match.index)
    const startLine = lineAtOffset(offsets, declIndex)
    if (bodyRanges.some((r) => startLine >= r.start && startLine <= r.end)) continue
    const lineEnd = content.indexOf("\n", declIndex)
    const code = content.substring(declIndex, lineEnd === -1 ? content.length : lineEnd)
    nodes.push({
      id: `${fileID}:variable:${name}:${startLine}`,
      kind: "variable",
      name,
      startLine,
      endLine: startLine,
      code,
    })
  }

  // Best-effort same-file call edges from identifier + `(` scans.
  const functionByName = new Map<string, ParsedNode>()
  for (const node of functionNodes) functionByName.set(node.name, node)
  const edgeIDs = new Set<string>()
  const addEdge = (id: string, fromNodeID: string, toNodeID: string, kind: ParsedEdge["kind"]) => {
    if (edgeIDs.has(id)) return
    edgeIDs.add(id)
    edges.push({ id, fromNodeID, toNodeID, kind })
  }
  for (const node of functionNodes) {
    if (!node.code) continue
    const strippedCode = stripCommentsAndStrings(node.code)
    for (const m of strippedCode.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
      const callee = m[1]
      if (!callee || callee === node.name || C_KEYWORDS.has(callee)) continue
      const target = functionByName.get(callee)
      if (target && target.id !== node.id) {
        addEdge(`${node.id}->${target.id}:calls`, node.id, target.id, "calls")
      }
    }
  }

  // Parent edges: every symbol is referenced by its containing file node.
  const fileNodeID = `${fileID}:file`
  for (const node of nodes) {
    addEdge(`${node.id}->${fileNodeID}:references`, node.id, fileNodeID, "references")
  }

  return { nodes, edges }
}

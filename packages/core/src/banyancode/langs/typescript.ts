import type { ParseResult, ParsedBinding, ParsedNode, ParsedEdge } from "./types"

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

// Binding-model regexes. These feed the import/export binding rows the
// derived-edge pass uses to resolve qualified references like
// `MeshCoordinator.Service` and barrel chains `Banyan.MeshCoordinator.Service`
// instead of matching the bare `Service` name heuristically.
const IMPORT_STATEMENT_REGEX = /import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g
const RE_EXPORT_STAR_AS_REGEX = /export\s+\*\s+as\s+(\w+)\s+from\s+["']([^"']+)["']/g
const RE_EXPORT_STAR_REGEX = /export\s+\*\s+from\s+["']([^"']+)["']/g
const RE_EXPORT_NAMED_REGEX = /export\s+(?:type\s+)?\{([^}]*)\}(?:\s+from\s+["']([^"']+)["'])?/g
const EXPORT_DECL_NAME_REGEX = /(?:^|\n)\s*export\s+(?:declare\s+|abstract\s+)?(default\s+)?(?:class|function|interface|type|const|let|var|enum)\s+(\w+)/g
const EXPORT_DEFAULT_IDENT_REGEX = /(?:^|\n)\s*export\s+default\s+(?!class\b|function\b|interface\b|type\b|const\b|let\b|var\b|enum\b)(\w+)/g

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

function getTSNodeBody(
  content: string,
  matchIndex: number,
  matchText: string,
  startLine: number,
): { code: string; endLine: number } {
  const afterMatchIndex = matchIndex + matchText.length
  let firstBrace = -1
  let firstSemicolon = -1
  for (let i = afterMatchIndex; i < content.length; i++) {
    if (content[i] === "{") {
      firstBrace = i
      break
    }
    if (content[i] === ";") {
      firstSemicolon = i
      break
    }
    if (content.substring(i, i + 9).startsWith("function ") || content.substring(i, i + 6).startsWith("class ")) {
      break
    }
  }
  if (firstBrace !== -1) {
    let braceCount = 1
    let i = firstBrace + 1
    while (i < content.length) {
      if (content[i] === "{") braceCount++
      else if (content[i] === "}") {
        braceCount--
        if (braceCount === 0) {
          const code = content.substring(matchIndex, i + 1)
          const endLine = startLine + code.split("\n").length - 1
          return { code, endLine }
        }
      }
      i++
    }
  }
  const endOffset = firstSemicolon !== -1 ? firstSemicolon + 1 : afterMatchIndex
  const code = content.substring(matchIndex, endOffset)
  const endLine = startLine + code.split("\n").length - 1
  return { code, endLine }
}

const CLASS_METHOD_REGEX = /(?:^|\n)\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\s*\{/g

function getArrowBody(
  content: string,
  matchIndex: number,
  matchText: string,
  startLine: number,
): { code: string; endLine: number } {
  const arrowIndex = content.indexOf("=>", matchIndex + matchText.length - 2)
  if (arrowIndex === -1) return getTSNodeBody(content, matchIndex, matchText, startLine)

  const afterArrow = arrowIndex + 2
  const rest = content.substring(afterArrow).trimStart()
  if (rest.startsWith("{")) {
    const braceStart = content.indexOf("{", afterArrow)
    return getTSNodeBody(content, matchIndex, content.substring(matchIndex, braceStart + 1), startLine)
  }

  const lineEnd = content.indexOf("\n", afterArrow)
  const endOffset = lineEnd === -1 ? content.length : lineEnd
  const code = content.substring(matchIndex, endOffset)
  const endLine = startLine + code.split("\n").length - 1
  return { code, endLine }
}

function getFactoryBody(
  content: string,
  matchIndex: number,
  matchText: string,
  startLine: number,
): { code: string; endLine: number } {
  const afterMatchIndex = matchIndex + matchText.length
  const openParen = content.indexOf("(", afterMatchIndex)
  if (openParen === -1) return getTSNodeBody(content, matchIndex, matchText, startLine)
  let parenCount = 1
  let i = openParen + 1
  while (i < content.length && parenCount > 0) {
    if (content[i] === "(") parenCount++
    else if (content[i] === ")") parenCount--
    i++
  }
  const closeParen = i - 1
  const code = content.substring(matchIndex, closeParen + 1)
  const endLine = startLine + code.split("\n").length - 1
  return { code, endLine }
}

function extractClassMethods(classCode: string, classStartLine: number, fileID: string, className: string): ParsedNode[] {
  const methods: ParsedNode[] = []
  const localOffsets = computeLineStartOffsets(classCode)
  for (const match of classCode.matchAll(CLASS_METHOD_REGEX)) {
    const name = match[1]
    if (name === "constructor") continue
    const localStart = lineAtOffset(localOffsets, match.index)
    const startLine = classStartLine + localStart - 1
    const { code, endLine: localEnd } = getTSNodeBody(classCode, match.index!, match[0], localStart)
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

// Extract import/export bindings that the derived-edge pass needs to resolve
// qualified references (`MeshCoordinator.Service`, barrel chains like
// `Banyan.MeshCoordinator.Service`) instead of falling back to name heuristics.
// The regexes are intentionally statement-level: they run on the raw source so
// comments/strings cannot fake a binding, and they never mutate the node/edge
// shape (bindings are an additive ParseResult field).
function extractBindings(content: string, fileID: string): ParsedBinding[] {
  const bindings: ParsedBinding[] = []

  for (const match of content.matchAll(IMPORT_STATEMENT_REGEX)) {
    const clauses = match[2] ?? ""
    const source = match[3] ?? ""
    if (!source) continue
    const clause = clauses.trim()
    if (clause.startsWith("* as ")) {
      const ns = clause.slice("* as ".length).trim().split(/\s+/)[0] ?? ""
      if (ns) {
        bindings.push({ id: `${fileID}:import:${ns}`, kind: "import", localName: ns, importedName: "*", exportName: "*", source })
      }
      continue
    }
    const braceIndex = clause.indexOf("{")
    if (braceIndex !== -1) {
      // `import { A, B as C } from "src"` — also handles the
      // `import D, { A } from "src"` form where the default specifier
      // precedes the brace block.
      const defaultName = clause.slice(0, braceIndex).trim()
      if (defaultName && defaultName !== "type") {
        bindings.push({ id: `${fileID}:import:${defaultName}`, kind: "import", localName: defaultName, importedName: "default", exportName: "default", source })
      }
      for (const item of clause.slice(braceIndex + 1, -1).split(",")) {
        const [a, , b] = item.trim().split(/\s+/)
        if (!a) continue
        const local = b ?? a
        bindings.push({ id: `${fileID}:import:${local}`, kind: "import", localName: local, exportName: a, importedName: a, source })
      }
      continue
    }
    if (clause && clause !== "type") {
      const defaultName = clause.split(",")[0]?.trim()
      if (defaultName) {
        bindings.push({ id: `${fileID}:import:${defaultName}`, kind: "import", localName: defaultName, importedName: "default", exportName: "default", source })
      }
    }
  }

  for (const match of content.matchAll(RE_EXPORT_STAR_AS_REGEX)) {
    const ns = match[1]!
    const source = match[2]!
    bindings.push({ id: `${fileID}:reexport:${ns}`, kind: "namespace-re-export", localName: ns, importedName: "*", exportName: "*", source })
  }

  for (const match of content.matchAll(RE_EXPORT_STAR_REGEX)) {
    const source = match[1]!
    bindings.push({ id: `${fileID}:reexport:*:${source}`, kind: "star-re-export", importedName: "*", exportName: "*", source })
  }

  for (const match of content.matchAll(RE_EXPORT_NAMED_REGEX)) {
    const items = match[1]!
    const source = match[2] ?? ""
    for (const item of items.split(",")) {
      const [a, , b] = item.trim().split(/\s+/)
      if (!a) continue
      const local = b ?? a
      bindings.push({
        id: `${fileID}:reexport:${a}`,
        kind: source ? "re-export" : "export",
        localName: local,
        importedName: a,
        exportName: a,
        source,
      })
    }
  }

  for (const match of content.matchAll(EXPORT_DECL_NAME_REGEX)) {
    const isDefault = match[1] === "default"
    const name = match[2]!
    bindings.push({
      id: `${fileID}:export:${name}`,
      kind: "export",
      localName: name,
      importedName: isDefault ? "default" : name,
      exportName: isDefault ? "default" : name,
      source: "",
    })
  }

  for (const match of content.matchAll(EXPORT_DEFAULT_IDENT_REGEX)) {
    const name = match[1]!
    bindings.push({ id: `${fileID}:export:default`, kind: "export", localName: name, importedName: "default", exportName: "default", source: "" })
  }

  const seen = new Set<string>()
  return bindings.filter((b) => {
    if (seen.has(b.id)) return false
    seen.add(b.id)
    return true
  })
}

export function parseTypeScript(content: string, fileID: string): ParseResult {
  const nodes: ParsedNode[] = []
  const edges: ParsedEdge[] = []
  const bindings = extractBindings(content, fileID)
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
    const { code, endLine } = getTSNodeBody(content, match.index, match[0], startLine)
    nodes.push({ id: `${fileID}:class:${name}:${startLine}`, kind: "class", name, startLine, endLine, code })
    nodes.push(...extractClassMethods(code, startLine, fileID, name))
  }

  for (const match of content.matchAll(CLASS_REGEX)) {
    const name = match[1]
    const startLine = lineAtOffset(offsets, match.index)
    const { code, endLine } = getTSNodeBody(content, match.index, match[0], startLine)
    nodes.push({ id: `${fileID}:class:${name}:${startLine}`, kind: "class", name, startLine, endLine, code })
    nodes.push(...extractClassMethods(code, startLine, fileID, name))
  }

  for (const match of content.matchAll(FUNCTION_REGEX)) {
    const name = match[1]
    const startLine = lineAtOffset(offsets, match.index)
    const { code, endLine } = getTSNodeBody(content, match.index, match[0], startLine)
    const effectMatch = code.match(EFFECT_FN_REGEX)
    const signature = effectMatch ? effectMatch[1] : match[0].trim()
    nodes.push({ id: `${fileID}:function:${name}:${startLine}`, kind: "function", name, startLine, endLine, signature, code })
  }

  for (const match of content.matchAll(FACTORY_EXPORT_REGEX)) {
    const name = match[1]
    const factoryCall = match[2]
    const signature = factoryCall.replace(/\s*\($/, "")
    const startLine = lineAtOffset(offsets, match.index)
    const { code, endLine } = getFactoryBody(content, match.index!, match[0], startLine)
    nodes.push({ id: `${fileID}:factory:${name}:${startLine}`, kind: "function", name, startLine, endLine, signature, code })
  }

  for (const match of content.matchAll(ARROW_CONST_REGEX)) {
    const name = match[1]
    const startLine = lineAtOffset(offsets, match.index)
    const { code, endLine } = getArrowBody(content, match.index!, match[0], startLine)
    const effectMatch = code.match(EFFECT_FN_REGEX)
    const signature = effectMatch ? effectMatch[1] : match[0].trim()
    nodes.push({ id: `${fileID}:function:${name}:${startLine}`, kind: "function", name, startLine, endLine, signature, code })
  }

  for (const match of content.matchAll(EFFECT_FN_CONST_REGEX)) {
    const name = match[1]
    const signature = match[2]
    const startLine = lineAtOffset(offsets, match.index)
    const afterMatchIndex = match.index + match[0].length
    let firstBrace = -1
    for (let i = afterMatchIndex; i < content.length; i++) {
      if (content[i] === "{") {
        firstBrace = i
        break
      }
    }
    let code = match[0]
    let endLine = startLine
    if (firstBrace !== -1) {
      let braceCount = 1
      let i = firstBrace + 1
      while (i < content.length) {
        if (content[i] === "{") braceCount++
        else if (content[i] === "}") {
          braceCount--
          if (braceCount === 0) {
            code = content.substring(match.index, i + 1)
            endLine = startLine + code.split("\n").length - 1
            break
          }
        }
        i++
      }
    }
    nodes.push({ id: `${fileID}:function:${name}:${startLine}`, kind: "function", name, startLine, endLine, signature, code })
  }

  for (const match of content.matchAll(INTERFACE_REGEX)) {
    const name = match[1]
    const startLine = lineAtOffset(offsets, match.index)
    const { code, endLine } = getTSNodeBody(content, match.index, match[0], startLine)
    nodes.push({ id: `${fileID}:type:${name}:${startLine}`, kind: "type", name, startLine, endLine, code })
    nodes.push(...extractInterfaceMembers(code, startLine, fileID, name))
  }

  for (const match of content.matchAll(TYPE_REGEX)) {
    const name = match[1]
    const startLine = lineAtOffset(offsets, match.index)
    const { code, endLine } = getTSNodeBody(content, match.index, match[0], startLine)
    nodes.push({ id: `${fileID}:type:${name}:${startLine}`, kind: "type", name, startLine, endLine, code })
  }

  return { nodes, edges, bindings }
}
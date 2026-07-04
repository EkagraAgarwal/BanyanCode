import type { ParseResult, ParsedNode, ParsedEdge } from "./types"

const IMPORTS_REGEX = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?["']([^"']+)["']/g
const EXPORT_CLASS_REGEX = /export\s+class\s+(\w+)(?:\s+extends\s+(\w+))?/g
const CLASS_REGEX = /(?:^|\n)(?!export\s+)class\s+(\w+)(?:\s+extends\s+(\w+))?/g
const FUNCTION_REGEX = /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g
const ARROW_CONST_REGEX = /(?:^|\n)(?:export\s+)?const\s+(\w+)\s*=\s*(async\s+)?(?:\([^)]*\)|[^=>\n]+)\s*=>/g
const INTERFACE_REGEX = /(?:^|\n)interface\s+(\w+)/g
const TYPE_REGEX = /(?:^|\n)type\s+(\w+)\s*=/g

function getTSNodeBody(content: string, matchIndex: number, matchText: string): { code: string; endLine: number } {
  const startLine = content.substring(0, matchIndex).split("\n").length
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

function getArrowBody(content: string, matchIndex: number, matchText: string): { code: string; endLine: number } {
  const startLine = content.substring(0, matchIndex).split("\n").length
  const arrowIndex = content.indexOf("=>", matchIndex + matchText.length - 2)
  if (arrowIndex === -1) return getTSNodeBody(content, matchIndex, matchText)

  const afterArrow = arrowIndex + 2
  const rest = content.substring(afterArrow).trimStart()
  if (rest.startsWith("{")) {
    const braceStart = content.indexOf("{", afterArrow)
    return getTSNodeBody(content, matchIndex, content.substring(matchIndex, braceStart + 1))
  }

  const lineEnd = content.indexOf("\n", afterArrow)
  const endOffset = lineEnd === -1 ? content.length : lineEnd
  const code = content.substring(matchIndex, endOffset)
  const endLine = startLine + code.split("\n").length - 1
  return { code, endLine }
}

function extractClassMethods(classCode: string, classStartLine: number, fileID: string, className: string): ParsedNode[] {
  const methods: ParsedNode[] = []
  for (const match of classCode.matchAll(CLASS_METHOD_REGEX)) {
    const name = match[1]
    if (name === "constructor") continue
    const localStart = classCode.substring(0, match.index).split("\n").length
    const startLine = classStartLine + localStart - 1
    const { code, endLine: localEnd } = getTSNodeBody(classCode, match.index!, match[0])
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

export function parseTypeScript(content: string, fileID: string): ParseResult {
  const nodes: ParsedNode[] = []
  const edges: ParsedEdge[] = []
  const imports: string[] = []

  for (const match of content.matchAll(IMPORTS_REGEX)) {
    imports.push(match[1])
  }

  for (const match of content.matchAll(EXPORT_CLASS_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const { code, endLine } = getTSNodeBody(content, match.index, match[0])
    nodes.push({ id: `${fileID}:class:${name}:${startLine}`, kind: "class", name, startLine, endLine, code })
    nodes.push(...extractClassMethods(code, startLine, fileID, name))
  }

  for (const match of content.matchAll(CLASS_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const { code, endLine } = getTSNodeBody(content, match.index, match[0])
    nodes.push({ id: `${fileID}:class:${name}:${startLine}`, kind: "class", name, startLine, endLine, code })
    nodes.push(...extractClassMethods(code, startLine, fileID, name))
  }

  for (const match of content.matchAll(FUNCTION_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const { code, endLine } = getTSNodeBody(content, match.index, match[0])
    nodes.push({ id: `${fileID}:function:${name}:${startLine}`, kind: "function", name, startLine, endLine, signature: match[0].trim(), code })
  }

  for (const match of content.matchAll(ARROW_CONST_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const { code, endLine } = getArrowBody(content, match.index!, match[0])
    nodes.push({ id: `${fileID}:function:${name}:${startLine}`, kind: "function", name, startLine, endLine, signature: match[0].trim(), code })
  }

  for (const match of content.matchAll(INTERFACE_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const { code, endLine } = getTSNodeBody(content, match.index, match[0])
    nodes.push({ id: `${fileID}:type:${name}:${startLine}`, kind: "type", name, startLine, endLine, code })
  }

  for (const match of content.matchAll(TYPE_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const { code, endLine } = getTSNodeBody(content, match.index, match[0])
    nodes.push({ id: `${fileID}:type:${name}:${startLine}`, kind: "type", name, startLine, endLine, code })
  }

  return { nodes, edges, imports }
}
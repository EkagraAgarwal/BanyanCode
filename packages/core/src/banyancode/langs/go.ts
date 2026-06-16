import type { ParseResult, ParsedNode, ParsedEdge } from "./types"

// Matches: func name(...) and func (receiver) name(...)
const FUNCTION_REGEX = /(?:^|\n)func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/g
// Matches: func (r *Type) name(...) - method on receiver
const METHOD_REGEX = /(?:^|\n)func\s+\([^)]+\)\s+(\w+)\s*\(/g
// Matches: type name struct and type name interface
const TYPE_REGEX = /(?:^|\n)type\s+(\w+)\s+(?:struct|interface)/g

function djb2Hash(content: string): string {
  let hash = 5381
  for (let i = 0; i < content.length; i++) {
    hash = (hash << 5) + hash + content.charCodeAt(i)
    hash = hash & hash
  }
  return Math.abs(hash).toString(16)
}

export function parseGo(
  content: string,
  fileID: string,
  filePath: string,
  language: string,
): ParseResult {
  const nodes: ParsedNode[] = []
  const edges: ParsedEdge[] = []
  const imports: string[] = []
  const relativePath = filePath.replace(/\\/g, "/")
  const textExcerpt = content.substring(0, 512)

  const addNode = (
    kind: ParsedNode["kind"],
    name: string,
    startLine: number,
    endLine: number,
    qualifiedName?: string,
  ) => {
    const qname = qualifiedName ?? relativePath + "::" + name
    nodes.push({
      id: fileID + ":" + kind + ":" + name + ":" + startLine,
      kind,
      name,
      qualifiedName: qname,
      startLine,
      startByte: 0,
      endLine,
      endByte: 0,
      language,
      textExcerpt,
      nodeCodeHash: djb2Hash(content.substring(0, 200)),
    })
  }

  // Extract imports from Go files
  const IMPORT_REGEX = /(?:^|\n)import\s+(?:\(\s*([\s\S]*?)\s*\)|(["'])([^"']+)\2)/gm
  for (const match of content.matchAll(IMPORT_REGEX)) {
    if (match[1]) {
      // Multi-line import
      const importBlock = match[1]
      const importMatches = importBlock.matchAll(/["']([^"']+)["']/g)
      for (const im of importMatches) {
        imports.push(im[1])
      }
    } else if (match[3]) {
      imports.push(match[3])
    }
  }

  // Find methods first (so we can skip them in function matches)
  const methodNames = new Set<string>()
  for (const match of content.matchAll(METHOD_REGEX)) {
    const name = match[1]
    methodNames.add(name)
  }

  // Add methods
  for (const match of content.matchAll(METHOD_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    // Extract receiver type from the match string itself
    const receiverPart = match[0].match(/\(([^)]+)\)/)?.[1] ?? ""
    const typeMatch = receiverPart.match(/\*\s*(\w+)|(\w+)$/)
    const receiverType = typeMatch?.[1] ?? typeMatch?.[2] ?? ""
    const qname = receiverType ? receiverType + "." + name : name
    addNode("method", name, startLine, endLine, qname)
  }

  // Add functions (not methods)
  for (const match of content.matchAll(FUNCTION_REGEX)) {
    const name = match[1]
    if (methodNames.has(name)) continue
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("function", name, startLine, endLine)
  }

  // Add types (structs and interfaces)
  for (const match of content.matchAll(TYPE_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("type", name, startLine, endLine)
  }

  // Add file node as root
  const fileName = relativePath.split("/").pop() ?? relativePath
  const fileNodeId = fileID + ":file:" + fileName + ":1"
  nodes.push({
    id: fileNodeId,
    kind: "type",
    name: fileName,
    qualifiedName: relativePath,
    startLine: 1,
    startByte: 0,
    endLine: content.split("\n").length,
    endByte: 0,
    language,
    textExcerpt,
    nodeCodeHash: djb2Hash(textExcerpt),
  })

  // Add imports edges from file to imported modules (unresolved - to_target_key only)
  for (const importPath of imports) {
    edges.push({
      id: fileID + ":imports:" + importPath,
      fromNodeID: fileNodeId,
      toNodeID: undefined,
      toTargetKey: "import:" + importPath,
      fileID,
      line: 1,
      kind: "imports",
      weight: 1,
    })
  }

  // Add contains edges from file to all nodes
  for (const node of nodes) {
    if (node.id !== fileNodeId) {
      edges.push({
        id: fileID + ":contains:" + node.id,
        fromNodeID: fileNodeId,
        toNodeID: node.id,
        fileID,
        line: node.startLine,
        kind: "contains",
        weight: 1,
      })
    }
  }

  return { nodes, edges, imports }
}
import type { ParseResult, ParsedNode, ParsedEdge } from "./types"

const FROM_IMPORT_REGEX = /from\s+(["'])([^"']+)\1\s+import\s+/g
const IMPORT_REGEX = /^import\s+(?:\{[^}]*\}|\w+|\*\s+as\s+\w+)\s+from\s+(["'])([^"']+)\2/gm
const CLASS_REGEX = /(?:^|\n)class\s+(\w+)(?:\s*\(\s*(\w+)\s*\))?/g
const DEF_REGEX = /(?:^|\n)def\s+(\w+)\s*\(/g

function djb2Hash(content: string): string {
  let hash = 5381
  for (let i = 0; i < content.length; i++) {
    hash = (hash << 5) + hash + content.charCodeAt(i)
    hash = hash & hash
  }
  return Math.abs(hash).toString(16)
}

export function parsePython(
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
  ) => {
    const qualifiedName = relativePath + "::" + name
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
      nodeCodeHash: djb2Hash(content.substring(0, 200)),
    })
  }

  for (const match of content.matchAll(FROM_IMPORT_REGEX)) {
    imports.push(match[2])
  }

  for (const match of content.matchAll(IMPORT_REGEX)) {
    imports.push(match[3])
  }

  for (const match of content.matchAll(CLASS_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("class", name, startLine, endLine)
  }

  for (const match of content.matchAll(DEF_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("function", name, startLine, endLine)
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
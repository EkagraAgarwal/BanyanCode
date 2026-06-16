import type { ParseResult, ParsedNode, ParsedEdge } from "./types"

const IMPORTS_REGEX = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?["']([^"']+)["']/g
const EXPORT_CLASS_REGEX = /export\s+class\s+(\w+)(?:\s+extends\s+(\w+))?/g
const CLASS_REGEX = /(?:^|\n)(?!export\s+)class\s+(\w+)(?:\s+extends\s+(\w+))?/g
const FUNCTION_REGEX = /(?:^|\n)(?:export\s+)?function\s+(\w+)\s*\(/g
const INTERFACE_REGEX = /(?:^|\n)interface\s+(\w+)/g
const TYPE_REGEX = /(?:^|\n)type\s+(\w+)\s*=/g

function djb2Hash(content: string): string {
  let hash = 5381
  for (let i = 0; i < content.length; i++) {
    hash = (hash << 5) + hash + content.charCodeAt(i)
    hash = hash & hash
  }
  return Math.abs(hash).toString(16)
}

export function parseTypeScript(
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
    signature?: string,
  ) => {
    const qualifiedName = relativePath + "::" + name
    const code = signature ?? content.substring(0, 200)
    nodes.push({
      id: fileID + ":" + kind + ":" + name + ":" + startLine,
      kind,
      name,
      qualifiedName,
      signature,
      startLine,
      startByte: 0,
      endLine,
      endByte: 0,
      language,
      textExcerpt,
      nodeCodeHash: djb2Hash(code),
      code,
    })
  }

  for (const match of content.matchAll(IMPORTS_REGEX)) {
    imports.push(match[1])
  }

  // Map from class node id to parent class name for extends edges
  const classExtendsMap: Map<string, string> = new Map()

  for (const match of content.matchAll(EXPORT_CLASS_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("class", name, startLine, endLine)
    const nodeId = fileID + ":class:" + name + ":" + startLine
    if (match[2]) {
      classExtendsMap.set(nodeId, match[2])
    }
  }

  for (const match of content.matchAll(CLASS_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("class", name, startLine, endLine)
    const nodeId = fileID + ":class:" + name + ":" + startLine
    if (match[2]) {
      classExtendsMap.set(nodeId, match[2])
    }
  }

  for (const match of content.matchAll(FUNCTION_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("function", name, startLine, endLine, match[0].trim())
  }

  for (const match of content.matchAll(INTERFACE_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("type", name, startLine, endLine)
  }

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

  // Add extends edges from class nodes to parent classes (unresolved - to_target_key only)
  for (const [classNodeId, parentClass] of classExtendsMap) {
    edges.push({
      id: classNodeId + ":extends:" + parentClass,
      fromNodeID: classNodeId,
      toNodeID: undefined,
      toTargetKey: parentClass,
      fileID,
      line: 1,
      kind: "extends",
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
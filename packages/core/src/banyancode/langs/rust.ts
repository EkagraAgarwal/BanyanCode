import type { ParseResult, ParsedNode, ParsedEdge } from "./types"

const FUNCTION_REGEX = /(?:^|\n)fn\s+(\w+)\s*[<(]/g
const STRUCT_REGEX = /(?:^|\n)struct\s+(\w+)/g
const TRAIT_REGEX = /(?:^|\n)trait\s+(\w+)/g
const ENUM_REGEX = /(?:^|\n)enum\s+(\w+)/g
const IMPL_REGEX = /(?:^|\n)impl\s+(?:<[^>]+>\s+)?(\w+)\s+for\s+(\w+)/g
const IMPL_TRAIT_REGEX = /(?:^|\n)impl\s+(?:<[^>]+>\s+)?trait\s+(\w+)\s+for\s+(\w+)/g
const USE_REGEX = /(?:^|\n)use\s+([^\n;]+)/g
const MOD_REGEX = /(?:^|\n)mod\s+(\w+)/g

function djb2Hash(content: string): string {
  let hash = 5381
  for (let i = 0; i < content.length; i++) {
    hash = (hash << 5) + hash + content.charCodeAt(i)
    hash = hash & hash
  }
  return Math.abs(hash).toString(16)
}

export function parseRust(
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

  // Extract imports
  for (const match of content.matchAll(USE_REGEX)) {
    imports.push(match[1].trim())
  }

  // Extract module declarations (mod X;)
  for (const match of content.matchAll(MOD_REGEX)) {
    imports.push(match[1].trim())
  }

  // Add functions
  for (const match of content.matchAll(FUNCTION_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("function", name, startLine, endLine)
  }

  // Add structs (as type kind)
  for (const match of content.matchAll(STRUCT_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("type", name, startLine, endLine)
  }

  // Add traits (as type kind)
  for (const match of content.matchAll(TRAIT_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("type", name, startLine, endLine)
  }

  // Add enums
  for (const match of content.matchAll(ENUM_REGEX)) {
    const name = match[1]
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    addNode("enum", name, startLine, endLine)
  }

  // Add impl blocks (impl Trait for Type or impl Type)
  // The 'trait' keyword may appear between 'impl' and the trait name
  const IMPL_FOR_REGEX = /(?:^|\n)impl\s+(?:trait\s+)?(?:<[^>]+>\s+)?(\w+)\s+for\s+(\w+)/g
  for (const match of content.matchAll(IMPL_FOR_REGEX)) {
    const startLine = content.substring(0, match.index).split("\n").length
    const endLine = startLine + match[0].split("\n").length
    // The impl block is for implementing trait match[1] for type match[2]
    // We name it "impl <type>" since that's what the impl is for
    const name = "impl " + match[2]
    addNode("type", name, startLine, endLine, relativePath + "::" + name)
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
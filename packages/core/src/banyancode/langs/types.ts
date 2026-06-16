export interface ParsedNode {
  id: string
  kind: "function" | "class" | "method" | "type" | "interface" | "enum" | "variable"
  name: string
  qualifiedName: string
  signature?: string
  startLine: number
  startByte: number
  endLine: number
  endByte: number
  language: string
  doc?: string
  textExcerpt: string
  nodeCodeHash: string
  code?: string
}

export interface ParsedEdge {
  id: string
  fromNodeID: string
  toNodeID?: string
  toTargetKey?: string
  fileID: string
  line: number
  kind: "contains" | "imports" | "calls" | "extends" | "implements" | "references" | "exports"
  weight: number
}

export interface ParseResult {
  nodes: ParsedNode[]
  edges: ParsedEdge[]
  imports: string[]
}

export interface LanguageParser {
  readonly extensions: readonly string[]
  readonly parse: (content: string, fileID: string, filePath: string, language: string) => ParseResult
}

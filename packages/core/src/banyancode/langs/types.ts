export interface ParsedNode {
  id: string
  kind:
    | "function"
    | "class"
    | "method"
    | "type"
    | "variable"
    | "test"
    | "route"
    | "config"
    | "build"
    | "package"
    | "generated"
    | "ci"
    | "docker"
    | "env"
    | "doc"
  name: string
  signature?: string
  startLine: number
  endLine: number
  code?: string
}

export interface ParsedEdge {
  id: string
  fromNodeID: string
  toNodeID: string
  kind:
    | "imports"
    | "calls"
    | "extends"
    | "references"
    | "tested_by"
    | "configured_by"
    | "built_by"
    | "mounts"
    | "generated_from"
}

export interface ParseResult {
  nodes: ParsedNode[]
  edges: ParsedEdge[]
  imports: string[]
}

export interface LanguageParser {
  readonly extensions: readonly string[]
  readonly parse: (content: string, fileID: string) => ParseResult
}
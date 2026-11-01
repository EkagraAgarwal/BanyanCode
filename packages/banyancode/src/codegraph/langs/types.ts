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
  /**
   * Phase 0 tree-sitter: which backend produced this edge. Regex parsers
   * emit `imports` edges with `module:` targets; tree-sitter query edges
   * (calls / yield / service_access) carry `symbol:` / `service:` targets.
   * The indexer uses this to decide which edges may survive when
   * BANYANCODE_TS_EDGES=parser is set.
   */
  source?: "regex" | "tree-sitter"
}

export interface ParseResult {
  nodes: ParsedNode[]
  edges: ParsedEdge[]
  /**
   * Phase 0 tree-sitter: which backend produced this result. Set to
   * "tree-sitter" by query-executor when the tree-sitter parse + query
   * pass ran; absent (or "regex") when the regex parser produced it
   * (wasm unavailable, no query bundle, or internal fallback). The
   * indexer stamps node derivation from this marker.
   */
  backend?: "regex" | "tree-sitter"
  /**
   * Phase 0 tree-sitter: first syntax error (ERROR / MISSING node) found
   * in the parsed AST, when the tree-sitter grammar flagged one. The
   * indexer records it via recordParseError and continues with this
   * result (nodes are always regex-produced).
   */
  syntaxError?: { line: number; message: string }
}

export interface LanguageParser {
  readonly extensions: readonly string[]
  readonly parse: (content: string, fileID: string) => ParseResult
}
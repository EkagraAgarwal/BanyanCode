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

export type ParsedBindingKind = "import" | "export" | "re-export" | "namespace-re-export" | "star-re-export"

export type ParsedBinding = {
  id: string
  kind: ParsedBindingKind
  /** Local name in the source file: import alias, exported declaration name, or re-exported local name. */
  localName?: string
  /** Consumer-visible export name. `"*"` for star re-exports, `"default"` for default exports. */
  exportName?: string
  /** For imports: the name imported from the source module (differs from `localName` for `import { A as B }`). */
  importedName?: string
  /** Module specifier. Empty for local (non re-export) declarations. */
  source: string
}

export interface ParseResult {
  nodes: ParsedNode[]
  edges: ParsedEdge[]
  bindings: ParsedBinding[]
}

export interface LanguageParser {
  readonly extensions: readonly string[]
  readonly parse: (content: string, fileID: string) => ParseResult
}
/**
 * Codegraph value types.
 *
 * Ported from v1 `packages/core/src/banyancode/types.ts` (memory/mesh types
 * dropped — those features are not part of workstream 3a). Field names and
 * shapes are unchanged so tool inputs/outputs stay byte-identical to v1.
 */
import { Schema } from "effect"
import type { ResolutionDerivation } from "./symbol-resolver.js"

export type CodegraphFile = {
  id: string
  path: string
  contentHash: string
  language: string
  indexedAt: number
  sizeBytes?: number
  mtimeMs?: number
}

export type CodegraphNodeKind =
  | "file"
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

export type CodegraphEdgeKind =
  | "imports"
  | "calls"
  | "extends"
  | "references"
  | "tested_by"
  | "configured_by"
  | "built_by"
  | "mounts"
  | "generated_from"

export type CodegraphNode = {
  id: string
  fileID: string
  kind: CodegraphNodeKind
  name: string
  signature?: string
  startLine: number
  endLine: number
  code?: string
  derivation?: CodegraphDerivation
  isEntrypoint?: 0 | 1
  inDegree?: number
}

export type CodegraphDerivation = "regex-v1" | "tree-sitter-v1" | "runtime-v1"

export const CodegraphNodeSchema = Schema.Struct({
  id: Schema.String,
  fileID: Schema.String,
  kind: Schema.Literals([
    "file",
    "function",
    "class",
    "method",
    "type",
    "variable",
    "test",
    "route",
    "config",
    "build",
    "package",
    "generated",
    "ci",
    "docker",
    "env",
    "doc",
  ]),
  name: Schema.String,
  signature: Schema.optional(Schema.String),
  startLine: Schema.Number,
  endLine: Schema.Number,
  code: Schema.optional(Schema.String),
  derivation: Schema.optional(Schema.Literals(["regex-v1", "tree-sitter-v1", "runtime-v1"])),
}).annotate({ identifier: "Banyan/CodegraphNode" })

export type CodegraphEdge = {
  id: string
  fromNodeID: string
  toNodeID: string
  kind: CodegraphEdgeKind
}

export interface CodegraphMeta {
  graphBuiltAt: number
  graphVersion: number
  graphCoverage: number
  totalFiles: number
  totalNodes: number
  totalEdges: number
  schemaVersion: number
  indexedRoot?: string
}

export const GraphMeta = Schema.Struct({
  graphBuiltAt: Schema.Number,
  graphVersion: Schema.Number,
  graphCoverage: Schema.Number,
  totalFiles: Schema.Number,
  totalNodes: Schema.Number,
  totalEdges: Schema.Number,
}).annotate({ identifier: "Banyan/GraphMeta" })

export type GraphMeta = typeof GraphMeta.Type

/** Row shape shared by `codegraph_meta` reads/writes. */
export type CodegraphMetaRow = CodegraphMeta

export type { ResolutionDerivation }

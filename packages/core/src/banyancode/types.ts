import { Schema } from "effect"

export type MemoryEntry = {
  id: string
  key: string
  value: unknown
  context?: string
  tags: string[]
  scope: "global" | "session"
  sessionID?: string
  createdAt: number
  expiresAt?: number
  agentID?: string
  version: number
  updatedAt: number
  namespace?: string
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("NotFoundError", {
  id: Schema.String,
}) {}

export class StaleWriteError extends Schema.TaggedErrorClass<StaleWriteError>()("StaleWriteError", {
  id: Schema.String,
  expectedVersion: Schema.Number,
  currentVersion: Schema.Number,
}) {}

export type CodegraphFile = {
  id: string
  path: string
  contentHash: string
  language: string
  indexedAt: number
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
}

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
}).annotate({ identifier: "Banyan/CodegraphNode" })

export type CodegraphEdge = {
  id: string
  fromNodeID: string
  toNodeID: string
  kind: CodegraphEdgeKind
}

export type SubagentMessage = {
  id: string
  parentSessionID: string
  fromSession: string
  fromAgent: string
  toSession?: string
  toAgent?: string
  kind: "request" | "inform" | "answer" | "poll" | "steer" | "checkpoint" | "plan" | "kill"
  payload: unknown
  deliveredAt?: number
  createdAt: number
}

export type PlanDefinition = {
  title: string
  steps: Array<{
    content: string
    status: "pending" | "in_progress" | "completed" | "cancelled"
  }>
  exitCriteria: string
}

export interface WorkspaceContext {
  readonly worktree: string
  readonly focusDirs: readonly string[]
}

export interface Diagnostic {
  readonly kind: string
  readonly message: string
}

export interface Ranking {
  readonly score: number
  readonly signals: {
    readonly exact: number
    readonly symbol: number
    readonly graph: number
    readonly git: number
    readonly workspace: number
  }
  readonly workspace?: WorkspaceContext
}

export interface ArchitecturalSlice {
  readonly status?: "success" | "partial" | "failed"
  readonly reason?: string
  readonly recoveryHint?: string
  readonly fallbackUsed?: boolean
  readonly degraded?: boolean
  readonly summary: string
  readonly entrypoints: readonly CodegraphNode[]
  readonly importantSymbols: readonly CodegraphNode[]
  readonly relatedTests: readonly CodegraphNode[]
  readonly relatedDocs: readonly CodegraphFile[]
  readonly configs: readonly CodegraphFile[]
  readonly routes: readonly CodegraphNode[]
  readonly dependencies: readonly { name: string; version?: string }[]
}

export interface RepositoryContext {
  readonly status?: "success" | "partial" | "failed"
  readonly reason?: string
  readonly recoveryHint?: string
  readonly fallbackUsed?: boolean
  readonly degraded?: boolean
  readonly query: string
  readonly symbols: readonly CodegraphNode[]
  readonly files: readonly CodegraphFile[]
  readonly graph: { readonly nodes: readonly CodegraphNode[]; readonly edges: readonly CodegraphEdge[] }
  readonly tests: readonly CodegraphNode[]
  readonly docs: readonly CodegraphFile[]
  readonly configs: readonly CodegraphFile[]
  readonly git: {
    readonly recentCommits: readonly { sha: string; subject: string; ts: number }[]
    readonly ownership: ReadonlyMap<string, number>
  }
  readonly workspace?: WorkspaceContext
  readonly diagnostics?: readonly Diagnostic[]
  readonly ranking: Ranking
}

export type PeerInfo = {
  sessionID: string
  agent: string
  status: "active" | "idle" | "disconnected"
  lastSeenAt: number
}

export type CodegraphMeta = {
  id: string
  graphBuiltAt: number
  graphVersion: number
  graphCoverage: number
  totalFiles: number
  totalNodes: number
  totalEdges: number
  schemaVersion: number
}

export const GraphMeta = Schema.Struct({
  graphBuiltAt: Schema.Number,
  graphVersion: Schema.Number,
  graphCoverage: Schema.Number,
  totalFiles: Schema.Number,
  totalNodes: Schema.Number,
  totalEdges: Schema.Number,
})
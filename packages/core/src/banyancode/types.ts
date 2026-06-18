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

export type CodegraphNode = {
  id: string
  fileID: string
  kind: "file" | "function" | "class" | "method" | "type" | "variable"
  name: string
  signature?: string
  startLine: number
  endLine: number
  code?: string
}

export type CodegraphEdge = {
  id: string
  fromNodeID: string
  toNodeID: string
  kind: "imports" | "calls" | "extends" | "references"
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
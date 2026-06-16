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
}

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
  kind: "file" | "function" | "class" | "method" | "type" | "interface" | "enum" | "variable"
  name: string
  qualifiedName: string
  startLine: number
  startByte: number
  endLine: number
  endByte: number
  language: string
  signature?: string
  doc?: string
  textExcerpt: string
  nodeCodeHash: string
  code?: string
}

export type CodegraphEdge = {
  id: string
  fromNodeID: string
  toNodeID?: string
  toTargetKey?: string
  fileID: string
  line: number
  kind: "contains" | "imports" | "calls" | "extends" | "implements" | "references" | "exports"
  weight: number
}

export type CodegraphRootRow = {
  id: string
  rootPath: string
  lastBuildAt: number | null
  indexedFileCount: number
  nodeCount: number
  edgeCount: number
  embeddingModel: string | null
  parserVersion: string
  createdAt: number
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

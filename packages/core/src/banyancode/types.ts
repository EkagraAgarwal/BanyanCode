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
  kind: "request" | "inform" | "answer" | "poll"
  payload: unknown
  deliveredAt?: number
  createdAt: number
}

export type PeerInfo = {
  sessionID: string
  agent: string
  status: "active" | "idle" | "disconnected"
  lastSeenAt: number
}

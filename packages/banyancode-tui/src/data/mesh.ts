import type { MeshNode } from "./pending-rpc"

export interface PeerRow {
  readonly sessionID: string
  readonly agent: string
  readonly status: "active" | "idle" | "disconnected"
  readonly cost?: number
  readonly tokens?: number
  readonly lastActivityAt?: number
}

export function meshState(node: MeshNode): PeerRow["status"] {
  if (node.state === "running" || node.state === "retry") return "active"
  if (node.state === "failed" || node.state === "interrupted") return "disconnected"
  return "idle"
}

export function peerTokens(node: MeshNode): number {
  return node.tokens.input + node.tokens.output + node.tokens.reasoning + node.tokens.cache.read + node.tokens.cache.write
}

/** Direct children of the root mesh node, as sidebar rows. */
export function meshPeers(root: MeshNode | undefined): PeerRow[] {
  if (!root) return []
  return root.children.map((child) => ({
    sessionID: child.sessionID,
    agent: child.agent ?? "agent",
    status: meshState(child),
    cost: child.cost,
    tokens: peerTokens(child),
    lastActivityAt: child.lastActivityAt ?? child.updatedAt,
  }))
}

export function flattenMesh(root: MeshNode | undefined): MeshNode[] {
  if (!root) return []
  const out: MeshNode[] = []
  const visit = (node: MeshNode) => {
    out.push(node)
    for (const child of node.children) visit(child)
  }
  visit(root)
  return out
}

/** Mesh state for one session ID, when the tree includes it. */
export function meshStateFor(root: MeshNode | undefined, sessionID: string): MeshNode["state"] | undefined {
  return flattenMesh(root).find((node) => node.sessionID === sessionID)?.state
}

export function meshCounts(root: MeshNode | undefined) {
  const nodes = flattenMesh(root)
  const active = nodes.filter((node) => node.state === "running" || node.state === "retry").length
  return { total: Math.max(0, nodes.length - 1), active }
}

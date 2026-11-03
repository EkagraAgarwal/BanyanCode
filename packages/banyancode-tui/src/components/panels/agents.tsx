import type { SessionInfo } from "@opencode/client"

export const AGENT_TREE_COLLAPSE_THRESHOLD = 5

export type AgentStatus = "done" | "running" | "queued" | "error"

export interface AgentNode {
  readonly session: SessionInfo
  readonly children: readonly AgentNode[]
  readonly totalCost: number
  readonly totalTokens: number
  readonly status: AgentStatus
  readonly killed: boolean
  readonly isPathToRunning: boolean
}

export function agentName(session: SessionInfo): string {
  return session.agent ?? "orchestrator"
}

export function groupAgentTreeChildren(children: readonly AgentNode[]): ReadonlyArray<
  | { readonly kind: "node"; readonly node: AgentNode }
  | { readonly kind: "group"; readonly key: string; readonly agentName: string; readonly nodes: readonly AgentNode[] }
> {
  const result: Array<
    | { readonly kind: "node"; readonly node: AgentNode }
    | { readonly kind: "group"; readonly key: string; readonly agentName: string; readonly nodes: readonly AgentNode[] }
  > = []
  let index = 0
  while (index < children.length) {
    const first = children[index]!
    const name = agentName(first.session)
    const nodes = [first]
    while (index + nodes.length < children.length && agentName(children[index + nodes.length]!.session) === name) {
      nodes.push(children[index + nodes.length]!)
    }
    if (nodes.length >= AGENT_TREE_COLLAPSE_THRESHOLD) {
      result.push({
        kind: "group",
        key: `${first.session.parentID ?? ""}:${name}:${first.session.id}`,
        agentName: name,
        nodes,
      })
    } else {
      result.push(...nodes.map((node) => ({ kind: "node" as const, node })))
    }
    index += nodes.length
  }
  return result
}

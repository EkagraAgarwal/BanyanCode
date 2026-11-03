import type { Context } from "@opencode/plugin/tui/context"
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

/** What a branch or pane shows for one subagent. */
export type ChildState = "running" | "waiting" | "done" | "failed"

export interface MeshChild {
  readonly sessionID: string
  readonly agent: string
  readonly title?: string | undefined
  readonly state: ChildState
  readonly cost: number
  readonly tokens: number
  readonly createdAt: number
  readonly lastActivityAt?: number | undefined
  /** Pending permissions plus questions for this child. */
  readonly pending: number
}

/**
 * `MeshNode.state` carries `running`/`retry` and `failed`/`interrupted`, but no
 * "waiting" and no "done". Waiting is a permission or question the child is
 * blocked on (the mesh status has no `blockedReason`), and everything else that
 * is neither running nor failed has finished. A session killed through
 * `mesh.kill` is durable in `MeshStatus.killed`, so it is failed here even when
 * its node state has already settled.
 */
export function childState(
  node: MeshNode,
  input: { readonly pending?: number | undefined; readonly killed?: boolean | undefined } = {},
): ChildState {
  if (input.killed || node.state === "failed" || node.state === "interrupted") return "failed"
  if ((input.pending ?? 0) > 0) return "waiting"
  if (node.state === "running" || node.state === "retry") return "running"
  return "done"
}

/**
 * Steering is not limited to running agents: `mesh.steer` prompts the child
 * without `resume: false`, which wakes it and starts a new turn, so a finished
 * or failed branch can recover. A killed session is the exception — its kill row
 * is durable and status hides it, so it cannot be revived. `state` accepts both
 * the pane's `ChildState` and the raw `MeshNode` state; `unknown` means the mesh
 * has not reported the child yet.
 */
export function canSteer(
  state: ChildState | MeshNode["state"] | undefined,
  options: { readonly killed?: boolean | undefined } = {},
): boolean {
  if (options.killed === true || state === undefined) return false
  return (
    state === "running" ||
    state === "waiting" ||
    state === "done" ||
    state === "failed" ||
    state === "retry" ||
    state === "idle" ||
    state === "interrupted"
  )
}

/** Pending permissions and questions for exactly this session. */
export function pendingCount(context: Context, sessionID: string): number {
  return (
    (context.data.session.permission.list(sessionID)?.length ?? 0) +
    (context.data.session.form.list(sessionID)?.length ?? 0)
  )
}

/**
 * Direct mesh children of a session, in spawn order, with the state a branch,
 * pane or status row shows. Call inside a `createMemo` to stay reactive.
 */
export function directChildren(input: {
  readonly context: Context
  readonly sessionID: string
  readonly root: MeshNode | undefined
  readonly killed?: ReadonlySet<string> | undefined
}): MeshChild[] {
  const node = flattenMesh(input.root).find((item) => item.sessionID === input.sessionID)
  if (!node) return []
  return node.children.map((child) => {
    const pending = pendingCount(input.context, child.sessionID)
    return {
      sessionID: child.sessionID,
      agent: child.agent ?? "agent",
      title: child.title,
      state: childState(child, { pending, killed: input.killed?.has(child.sessionID) }),
      cost: child.cost,
      tokens: peerTokens(child),
      createdAt: child.createdAt,
      lastActivityAt: child.lastActivityAt ?? child.updatedAt,
      pending,
    }
  })
}

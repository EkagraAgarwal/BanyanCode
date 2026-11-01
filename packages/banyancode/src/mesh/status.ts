import { DateTime } from "effect"
import type { Session } from "@opencode/schema/session"
import type { AgentState, MeshNode, MeshSessionSnapshot, MeshStatus, TokenCounts } from "./types.js"
import { emptyTokens } from "./types.js"

export type LiveState = "busy" | "retry" | "idle"

const epoch = (value: DateTime.Utc | undefined): number | undefined =>
  value === undefined ? undefined : DateTime.toEpochMillis(value)

/** Maps a v2 `Session.Info` onto the host-neutral snapshot the tree builder uses. */
export const snapshotFromInfo = (info: Session.Info): MeshSessionSnapshot => ({
  sessionID: info.id,
  ...(info.parentID === undefined ? {} : { parentID: info.parentID }),
  ...(info.title === undefined ? {} : { title: info.title }),
  ...(info.agent === undefined ? {} : { agent: info.agent }),
  ...(info.model === undefined
    ? {}
    : {
        model: {
          providerID: info.model.providerID,
          id: info.model.id,
          ...(info.model.variant === undefined ? {} : { variant: info.model.variant }),
        },
      }),
  cost: info.cost,
  tokens: info.tokens as TokenCounts,
  createdAt: epoch(info.time.created) ?? 0,
  updatedAt: epoch(info.time.updated) ?? 0,
  ...(epoch(info.time.busy) === undefined ? {} : { busyAt: epoch(info.time.busy) }),
  ...(epoch(info.time.idle) === undefined ? {} : { idleAt: epoch(info.time.idle) }),
  ...(info.outcome === undefined ? {} : { outcome: info.outcome }),
})

export const stateOf = (snapshot: MeshSessionSnapshot, live?: LiveState): AgentState => {
  if (live === "retry") return "retry"
  if (live === "busy") return "running"
  if (snapshot.busyAt !== undefined && (snapshot.idleAt === undefined || snapshot.busyAt > snapshot.idleAt)) {
    return "running"
  }
  if (snapshot.outcome === "failed") return "failed"
  if (snapshot.outcome === "interrupted") return "interrupted"
  if (snapshot.idleAt !== undefined) return "idle"
  return "unknown"
}

export const reduceLiveStatus = (
  live: ReadonlyMap<string, LiveState>,
  event:
    | { readonly type: "session.status"; readonly sessionID: string; readonly status: "busy" | "retry" | "idle" }
    | {
        readonly type: "session.execution.started" | "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted"
        readonly sessionID: string
      },
): Map<string, LiveState> => {
  const next = new Map(live)
  if (event.type === "session.status") {
    next.set(event.sessionID, event.status)
    return next
  }
  next.set(event.sessionID, event.type === "session.execution.started" ? "busy" : "idle")
  return next
}

export const upsertSnapshot = (
  sessions: ReadonlyMap<string, MeshSessionSnapshot>,
  snapshot: MeshSessionSnapshot,
): Map<string, MeshSessionSnapshot> => {
  const next = new Map(sessions)
  next.set(snapshot.sessionID, snapshot)
  return next
}

export const removeSnapshot = (
  sessions: ReadonlyMap<string, MeshSessionSnapshot>,
  sessionID: string,
): Map<string, MeshSessionSnapshot> => {
  const next = new Map(sessions)
  next.delete(sessionID)
  return next
}

/** Topmost ancestor of `sessionID` (the orchestration tree root). */
export const rootOf = (sessions: ReadonlyMap<string, MeshSessionSnapshot>, sessionID: string): string | undefined => {
  let current = sessions.get(sessionID)
  if (current === undefined) return undefined
  const seen = new Set<string>()
  while (current.parentID !== undefined) {
    if (seen.has(current.sessionID)) break
    seen.add(current.sessionID)
    const parent = sessions.get(current.parentID)
    if (parent === undefined) break
    current = parent
  }
  return current.sessionID
}

const childrenOf = (
  sessions: ReadonlyMap<string, MeshSessionSnapshot>,
): Map<string, MeshSessionSnapshot[]> => {
  const byParent = new Map<string, MeshSessionSnapshot[]>()
  for (const snapshot of sessions.values()) {
    if (snapshot.parentID === undefined) continue
    const list = byParent.get(snapshot.parentID)
    if (list === undefined) byParent.set(snapshot.parentID, [snapshot])
    else list.push(snapshot)
  }
  return byParent
}

const toNode = (
  snapshot: MeshSessionSnapshot,
  byParent: ReadonlyMap<string, MeshSessionSnapshot[]>,
  live: ReadonlyMap<string, LiveState>,
): MeshNode => {
  const children = (byParent.get(snapshot.sessionID) ?? [])
    .slice()
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((child) => toNode(child, byParent, live))
  return {
    sessionID: snapshot.sessionID,
    ...(snapshot.parentID === undefined ? {} : { parentID: snapshot.parentID }),
    ...(snapshot.title === undefined ? {} : { title: snapshot.title }),
    ...(snapshot.agent === undefined ? {} : { agent: snapshot.agent }),
    ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
    state: stateOf(snapshot, live.get(snapshot.sessionID)),
    cost: snapshot.cost,
    tokens: snapshot.tokens ?? emptyTokens(),
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    ...(snapshot.busyAt === undefined && snapshot.idleAt === undefined
      ? {}
      : { lastActivityAt: Math.max(snapshot.busyAt ?? 0, snapshot.idleAt ?? 0, snapshot.updatedAt) }),
    children,
  }
}

export const buildForest = (
  sessions: ReadonlyMap<string, MeshSessionSnapshot>,
  live: ReadonlyMap<string, LiveState> = new Map(),
): readonly MeshNode[] => {
  const byParent = childrenOf(sessions)
  return Array.from(sessions.values())
    .filter((snapshot) => snapshot.parentID === undefined || !sessions.has(snapshot.parentID))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((snapshot) => toNode(snapshot, byParent, live))
}

/** Subtree for one session (including itself). */
export const treeFor = (
  sessions: ReadonlyMap<string, MeshSessionSnapshot>,
  rootSessionID: string,
  live: ReadonlyMap<string, LiveState> = new Map(),
): MeshNode | undefined => {
  const root = sessions.get(rootSessionID)
  if (root === undefined) return undefined
  return toNode(root, childrenOf(sessions), live)
}

export const buildStatus = (
  sessions: ReadonlyMap<string, MeshSessionSnapshot>,
  live: ReadonlyMap<string, LiveState> = new Map(),
  rootSessionID?: string,
): MeshStatus => {
  const scoped = rootSessionID === undefined ? undefined : treeFor(sessions, rootSessionID, live)
  return {
    roots: scoped === undefined ? buildForest(sessions, live) : [scoped],
    generatedAt: Date.now(),
  }
}

export const descendantsOf = (
  sessions: ReadonlyMap<string, MeshSessionSnapshot>,
  rootSessionID: string,
): readonly MeshSessionSnapshot[] => {
  const byParent = childrenOf(sessions)
  const out: MeshSessionSnapshot[] = []
  const walk = (id: string) => {
    for (const child of byParent.get(id) ?? []) {
      out.push(child)
      walk(child.sessionID)
    }
  }
  walk(rootSessionID)
  return out
}

export const flattenTree = (node: MeshNode): readonly MeshNode[] => [
  node,
  ...node.children.flatMap((child) => flattenTree(child)),
]

/** Number of descendants of `rootSessionID` that are currently running. */
export const countRunningDescendants = (
  sessions: ReadonlyMap<string, MeshSessionSnapshot>,
  rootSessionID: string,
  live: ReadonlyMap<string, LiveState> = new Map(),
): number => descendantsOf(sessions, rootSessionID).filter((snapshot) => stateOf(snapshot, live.get(snapshot.sessionID)) === "running").length

import { createSignal } from "solid-js"

export interface DismissedBranches {
  /** True while this branch's continuous failure is dismissed. Reactive. */
  isDismissed(rootSessionID: string, sessionID: string): boolean
  dismiss(rootSessionID: string, sessionIDs: readonly string[]): void
  /**
   * Keep only dismissals whose branch is still failed. `failedSessionIDs` is
   * the rail's current failed set, derived from real mesh data.
   */
  prune(rootSessionID: string, failedSessionIDs: readonly string[]): void
  /** Dismissals held for one root, so a test can prove entries do not leak. */
  count(rootSessionID: string): number
}

/**
 * In-memory per-root dismissal for failed and killed branches.
 *
 * A dismissal covers one continuous failure. It is keyed only by the child's
 * session ID, so later updates to that node — a title or summary write, a late
 * settle, a moved `updatedAt`/`lastActivityAt` — never end it. Pruning against
 * the rail's current failed set is what ends it: when the branch leaves
 * `failed` (a new run, done, waiting) or leaves the mesh, its ID drops out and
 * a later failure shows again. Callers must prune only from a real mesh tree,
 * never from a transiently missing response.
 */
export function createDismissedBranches(): DismissedBranches {
  const [byRoot, setByRoot] = createSignal<ReadonlyMap<string, ReadonlySet<string>>>(new Map())

  const write = (rootSessionID: string, next: ReadonlySet<string>) =>
    setByRoot((previous) => {
      const map = new Map(previous)
      if (next.size === 0) map.delete(rootSessionID)
      else map.set(rootSessionID, next)
      return map
    })

  return {
    isDismissed: (rootSessionID, sessionID) => byRoot().get(rootSessionID)?.has(sessionID) ?? false,
    dismiss: (rootSessionID, sessionIDs) => {
      if (sessionIDs.length === 0) return
      const next = new Set(byRoot().get(rootSessionID))
      for (const sessionID of sessionIDs) next.add(sessionID)
      write(rootSessionID, next)
    },
    prune: (rootSessionID, failedSessionIDs) => {
      const existing = byRoot().get(rootSessionID)
      if (existing === undefined) return
      const failed = new Set(failedSessionIDs)
      const next = new Set([...existing].filter((sessionID) => failed.has(sessionID)))
      if (next.size === existing.size) return
      write(rootSessionID, next)
    },
    count: (rootSessionID) => byRoot().get(rootSessionID)?.size ?? 0,
  }
}

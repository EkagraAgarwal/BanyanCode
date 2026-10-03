const disposers = new Set<(directory: string) => Promise<void>>()

export function registerDisposer(disposer: (directory: string) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

export async function disposeInstance(directory: string) {
  await Promise.allSettled([...disposers].map((disposer) => disposer(directory)))
}

// Eviction guards for InstanceStore's idle sweep. Producers record
// per-directory load here with plain sync calls (no Effect, no layer deps,
// so session/snapshot modules can report without import cycles):
// - SessionStatus.set reports its absolute busy count per instance.
// - Snapshot.track brackets each run with addActiveSnapshot(+1/-1).
// Absolute counts (not bare booleans) keep the ledger self-healing: a missed
// idle transition is corrected by the next set() for that directory.
const busySessions = new Map<string, number>()
const activeSnapshots = new Map<string, number>()

export function setBusySessions(directory: string, count: number) {
  if (count <= 0) busySessions.delete(directory)
  else busySessions.set(directory, count)
}

export function addActiveSnapshot(directory: string, delta: 1 | -1) {
  const next = (activeSnapshots.get(directory) ?? 0) + delta
  if (next <= 0) activeSnapshots.delete(directory)
  else activeSnapshots.set(directory, next)
}

// True when the directory has a busy session or an in-flight snapshot and
// must never be evicted.
export function hasEvictionBlocker(directory: string): boolean {
  return (busySessions.get(directory) ?? 0) > 0 || (activeSnapshots.get(directory) ?? 0) > 0
}

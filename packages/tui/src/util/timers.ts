/**
 * Tracked one-shot timeouts with collective disposal.
 *
 * `later()` schedules a timeout and tracks it; `dispose()` clears every
 * pending timeout (call from `onCleanup`). Fired timeouts untrack
 * themselves, so the set only ever holds pending timers. A `later()` after
 * `dispose()` still schedules normally — disposal is a cleanup point, not
 * a shutdown latch (see `createDebouncedWriter` for the latching variant).
 */
export function createTimeoutTracker() {
  const pending = new Set<ReturnType<typeof setTimeout>>()

  return {
    later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
      const id = setTimeout(() => {
        pending.delete(id)
        fn()
      }, ms)
      pending.add(id)
      return id
    },
    clear(id: ReturnType<typeof setTimeout>): void {
      if (pending.delete(id)) clearTimeout(id)
    },
    dispose(): void {
      for (const id of pending) clearTimeout(id)
      pending.clear()
    },
    get size(): number {
      return pending.size
    },
  }
}

export type TimeoutTracker = ReturnType<typeof createTimeoutTracker>

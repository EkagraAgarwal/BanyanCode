/**
 * Trailing-edge debounce for persistence writes.
 *
 * `schedule()` coalesces rapid calls (sidebar drags fire a `set` per mouse
 * move) into a single `write()` after `delayMs` of quiet. The write callback
 * reads current state when it fires, so only one snapshot is taken per
 * flush — never one per `set`. `flush()` writes pending state immediately;
 * `dispose()` flushes and disarms the timer (call from `onCleanup`).
 * A `schedule()` after `dispose()` writes through directly so a stray late
 * set is never silently dropped. Write errors belong to the callback.
 */
export function createDebouncedWriter(write: () => void, delayMs = 250) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  let disposed = false

  const fire = () => {
    timer = undefined
    if (!pending) return
    pending = false
    write()
  }

  return {
    schedule() {
      if (disposed) {
        write()
        return
      }
      pending = true
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(fire, delayMs)
    },
    flush() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (!pending) return
      pending = false
      write()
    },
    dispose() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      disposed = true
      if (!pending) return
      pending = false
      write()
    },
  }
}

export type DebouncedWriter = ReturnType<typeof createDebouncedWriter>

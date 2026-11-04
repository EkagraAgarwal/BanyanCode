import { Effect, Queue, Ref, type Duration, type Scope } from "effect"

/**
 * Coalesces a burst of dirty keys into at most one flush per window.
 *
 * A busy turn emits several session events per streamed part, and every one of
 * them used to rebuild and push a whole status tree. `mark` is O(1) and never
 * blocks the event subscription; the flusher waits one window, then hands the
 * union of everything marked since the last flush to `flush`. Keys marked while
 * a flush is running schedule the next window, so the **final** state of a
 * burst is always delivered (trailing edge) even when events keep arriving.
 */
export const makeKeyCoalescer = (options: {
  readonly window: Duration.Input
  readonly flush: (keys: ReadonlySet<string>) => Effect.Effect<void>
}): Effect.Effect<{ readonly mark: (key: string) => Effect.Effect<void> }, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pending = yield* Ref.make<ReadonlySet<string>>(new Set())
    // A single-slot nudge: only one flusher is ever waiting, and a second wakeup
    // while it is running must not queue work it will never read.
    const nudge = yield* Queue.sliding<void>(1)
    const mark = (key: string) =>
      Effect.gen(function* () {
        const first = yield* Ref.modify(pending, (keys) => {
          const next = new Set(keys)
          next.add(key)
          return [keys.size === 0, next] as const
        })
        if (first) yield* Queue.offer(nudge, undefined)
      })
    yield* Effect.forever(
      Effect.gen(function* () {
        yield* Queue.take(nudge)
        yield* Effect.sleep(options.window)
        const keys = yield* Ref.getAndSet(pending, new Set())
        if (keys.size > 0) yield* options.flush(keys)
      }),
    ).pipe(Effect.forkScoped({ startImmediately: true }))
    return { mark }
  })

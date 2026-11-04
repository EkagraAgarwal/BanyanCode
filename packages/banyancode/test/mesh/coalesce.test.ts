import { expect, test } from "bun:test"
import { Effect } from "effect"
import { makeKeyCoalescer } from "../../src/mesh/coalesce.js"

/**
 * `status.updated` used to be pushed once per session event, which is several
 * times per streamed part. The coalescer is what keeps the push rate bounded
 * without dropping the final state of a burst.
 */

const collect = (windows: ReadonlyArray<string>[]) => ({
  flush: (keys: ReadonlySet<string>) =>
    Effect.sync(() => {
      windows.push([...keys])
    }),
})

test("collapses a burst into one flush that carries every key", async () => {
  const windows: ReadonlyArray<string>[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeKeyCoalescer({ window: "10 millis", ...collect(windows) })
        yield* coalescer.mark("a")
        yield* coalescer.mark("b")
        yield* coalescer.mark("a")
        yield* coalescer.mark("c")
        yield* Effect.sleep("40 millis")
      }),
    ),
  )
  expect(windows).toHaveLength(1)
  expect([...windows[0]!].sort()).toEqual(["a", "b", "c"])
})

test("marks nothing, flushes nothing", async () => {
  const windows: ReadonlyArray<string>[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* makeKeyCoalescer({ window: "10 millis", ...collect(windows) })
        yield* Effect.sleep("40 millis")
      }),
    ),
  )
  expect(windows).toHaveLength(0)
})

test("a key marked while a flush runs lands in the next window (trailing edge)", async () => {
  const windows: ReadonlyArray<string>[] = []
  let reentrant = true
  let mark: ((key: string) => Effect.Effect<void>) | undefined
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeKeyCoalescer({
          window: "10 millis",
          flush: (keys): Effect.Effect<void> =>
            Effect.gen(function* () {
              windows.push([...keys])
              // The session changes again after the snapshot was taken: the
              // state the client must end on is the one from this mark.
              if (reentrant) {
                reentrant = false
                yield* mark!("a")
              }
            }),
        })
        mark = coalescer.mark
        yield* coalescer.mark("a")
        yield* Effect.sleep("60 millis")
      }),
    ),
  )
  expect(windows.length).toBeGreaterThanOrEqual(2)
  expect(windows.at(-1)).toEqual(["a"])
})

import { describe, expect, test } from "bun:test"
import { Effect, Queue, Stream } from "effect"
import { coalesceFileChanges, type FileChange } from "@opencode-ai/core/filesystem/watcher"

describe("coalesceFileChanges", () => {
  test("collapses a burst for one path to the last state", () => {
    const changes: FileChange[] = [
      { file: "a.txt", event: "add" },
      { file: "a.txt", event: "change" },
      { file: "a.txt", event: "change" },
    ]
    expect(coalesceFileChanges(changes)).toEqual([{ file: "a.txt", event: "change" }])
  })

  test("add then unlink collapses to unlink", () => {
    expect(
      coalesceFileChanges([
        { file: "a.txt", event: "add" },
        { file: "a.txt", event: "unlink" },
      ]),
    ).toEqual([{ file: "a.txt", event: "unlink" }])
  })

  test("unlink then add collapses to add", () => {
    expect(
      coalesceFileChanges([
        { file: "a.txt", event: "unlink" },
        { file: "a.txt", event: "add" },
      ]),
    ).toEqual([{ file: "a.txt", event: "add" }])
  })

  test("preserves one entry per distinct path", () => {
    const changes: FileChange[] = [
      { file: "a.txt", event: "add" },
      { file: "b.txt", event: "change" },
      { file: "a.txt", event: "change" },
      { file: "c.txt", event: "unlink" },
    ]
    expect(coalesceFileChanges(changes)).toEqual([
      { file: "a.txt", event: "change" },
      { file: "b.txt", event: "change" },
      { file: "c.txt", event: "unlink" },
    ])
  })

  test("empty in, empty out", () => {
    expect(coalesceFileChanges([])).toEqual([])
  })
})

describe("watcher backpressure contract", () => {
  test("sliding queue drops oldest under flood without suspending offers", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.sliding<number>(4)
      // Synchronous offers with no consumer attached: a bounded queue would
      // suspend here and park a fiber per batch (unbounded fiber growth).
      for (let i = 0; i < 10; i++) Queue.offerUnsafe(queue, i)
      expect(yield* Queue.takeAll(queue)).toEqual([6, 7, 8, 9])
      yield* Queue.shutdown(queue)
    }).pipe(Effect.runPromise),
  )

  test("grouped drain emits one batch that coalesces to one event per path", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.sliding<FileChange>(1024)
      const burst: FileChange[] = [
        { file: "a.txt", event: "add" },
        { file: "a.txt", event: "change" },
        { file: "b.txt", event: "change" },
        { file: "a.txt", event: "change" },
      ]
      for (const change of burst) Queue.offerUnsafe(queue, change)
      const chunks = yield* Stream.fromQueue(queue).pipe(
        Stream.groupedWithin(256, "50 millis"),
        Stream.take(1),
        Stream.runCollect,
      )
      const batch = Array.from(chunks).flatMap((chunk) => Array.from(chunk))
      expect(coalesceFileChanges(batch)).toEqual([
        { file: "a.txt", event: "change" },
        { file: "b.txt", event: "change" },
      ])
      yield* Queue.shutdown(queue)
    }).pipe(Effect.runPromise),
  )
})

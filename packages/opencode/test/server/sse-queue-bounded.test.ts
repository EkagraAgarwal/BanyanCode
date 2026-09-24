import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Phase 3: the live SSE handler must use a sliding/bounded queue, not
 * Queue.unbounded, so bursty event fan-out cannot grow RAM without limit.
 */
describe("SSE event queue bound", () => {
  test("event handler source uses Queue.sliding", () => {
    const source = readFileSync(
      path.join(import.meta.dir, "../../src/server/routes/instance/httpapi/handlers/event.ts"),
      "utf8",
    )
    expect(source).toMatch(/Queue\.sliding\s*<[^>]*>\s*\(\s*\d+\s*\)/)
    expect(source).not.toMatch(/Queue\.unbounded\s*<\s*EventV2\.Payload\s*>/)
  })

  test("Queue.sliding drops oldest under overflow", async () => {
    const taken = await Effect.runPromise(
      Effect.gen(function* () {
        const q = yield* Queue.sliding<number>(3)
        yield* Queue.offer(q, 1)
        yield* Queue.offer(q, 2)
        yield* Queue.offer(q, 3)
        yield* Queue.offer(q, 4)
        return [...(yield* Queue.takeAll(q))]
      }),
    )
    expect(taken).toEqual([2, 3, 4])
  })
})

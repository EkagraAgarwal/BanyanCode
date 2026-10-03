import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { readFileSync } from "node:fs"
import path from "node:path"
import { EventV2Bridge } from "../../src/event-v2-bridge"

/**
 * R4: the /global/event SSE handler must use a sliding/bounded queue, not an
 * unbounded Stream.callback buffer, so a stalled client cannot grow RAM
 * without limit on a stream that carries every directory's events.
 * R3: sync envelopes must never be serialized to SSE clients — each one
 * duplicates the plain event's data and TUI/CLI consumers drop it anyway.
 */
describe("global event SSE bound", () => {
  const source = readFileSync(
    path.join(import.meta.dir, "../../src/server/routes/instance/httpapi/handlers/global.ts"),
    "utf8",
  )

  test("global event source uses Queue.sliding with a 512 bound", () => {
    expect(source).toMatch(/Queue\.sliding\s*<\s*GlobalBusEvent\s*>\s*\(\s*512\s*\)/)
    expect(source).not.toMatch(/Queue\.unbounded/)
    expect(source).not.toMatch(/Stream\.callback\s*<\s*GlobalBusEvent/)
  })

  test("global event source skips sync envelopes before queueing", () => {
    expect(source).toMatch(/isSyncEnvelope/)
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

describe("isSyncEnvelope", () => {
  test("matches only the sync duplicate envelope", () => {
    expect(EventV2Bridge.isSyncEnvelope({ payload: { type: "sync" } })).toBe(true)
    expect(EventV2Bridge.isSyncEnvelope({ payload: { type: "session.created", properties: {} } })).toBe(false)
    expect(EventV2Bridge.isSyncEnvelope({ payload: { type: "server.heartbeat", properties: {} } })).toBe(false)
    expect(EventV2Bridge.isSyncEnvelope({} as { payload?: unknown })).toBe(false)
  })
})

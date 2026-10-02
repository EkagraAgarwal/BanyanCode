import { expect, test } from "bun:test"
import { createDebouncedWriter } from "../../src/util/debounced-writer"

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("rapid schedules coalesce into one write and the last value wins", async () => {
  const seen: number[] = []
  let current = 0
  // The write callback reads state at fire time, mirroring kv.tsx snapshotting
  // the store on flush rather than on every set.
  const writer = createDebouncedWriter(() => {
    seen.push(current)
  }, 50)
  for (let i = 1; i <= 5; i++) {
    current = i
    writer.schedule()
  }
  expect(seen).toEqual([])
  await settle(120)
  expect(seen).toEqual([5])
  writer.dispose()
})

test("flush writes pending state immediately without waiting for the delay", async () => {
  const seen: string[] = []
  const writer = createDebouncedWriter(() => {
    seen.push("wrote")
  }, 10_000)
  writer.schedule()
  expect(seen).toEqual([])
  writer.flush()
  expect(seen).toEqual(["wrote"])
  // No trailing write fires after the delay once flushed.
  await settle(20)
  expect(seen).toEqual(["wrote"])
  writer.dispose()
})

test("dispose flushes the pending tail and writes through afterwards", async () => {
  const seen: number[] = []
  let current = 0
  const writer = createDebouncedWriter(() => {
    seen.push(current)
  }, 10_000)
  current = 7
  writer.schedule()
  writer.dispose()
  expect(seen).toEqual([7])
  // A stray late schedule after unmount still persists instead of dropping.
  current = 8
  writer.schedule()
  expect(seen).toEqual([7, 8])
})

test("idle dispose and flush are no-ops", async () => {
  let calls = 0
  const writer = createDebouncedWriter(() => {
    calls++
  }, 20)
  writer.flush()
  writer.dispose()
  await settle(50)
  expect(calls).toBe(0)
})

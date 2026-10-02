import { describe, expect, test } from "bun:test"
import {
  STREAMING_METADATA_FLUSH_INTERVAL_MS,
  createByteCounter,
  createStreamingMetadataThrottle,
} from "../../src/tool/shell"

describe("streaming metadata throttle", () => {
  test("rapid chunks coalesce to ~200ms flushes with a complete trailing flush", () => {
    let now = 0
    const throttle = createStreamingMetadataThrottle(STREAMING_METADATA_FLUSH_INTERVAL_MS, () => now)
    let flushes = 0
    let acc = ""
    for (let i = 0; i < 1000; i++) {
      now += 1
      acc += `line ${i}\n`
      if (throttle.offer(acc)) flushes++
    }
    // 1s window at 200ms intervals: flushes at t=200,400,600,800,1000.
    expect(flushes).toBeLessThanOrEqual(5)
    expect(flushes).toBeGreaterThan(0)
    // Chunks after the last flush stay pending, then land in one final write.
    // (now is 1000, last flush at 801: 199ms < interval, so this coalesces.)
    acc += "tail\n"
    expect(throttle.offer(acc)).toBe(false)
    expect(throttle.pending).toBe(acc)
    expect(throttle.takePending()).toBe(acc)
    expect(throttle.pending).toBeUndefined()
    expect(throttle.takePending()).toBeUndefined()
  })

  test("slow chunks always flush", () => {
    let now = 0
    const throttle = createStreamingMetadataThrottle(STREAMING_METADATA_FLUSH_INTERVAL_MS, () => now)
    for (let i = 0; i < 3; i++) {
      now += STREAMING_METADATA_FLUSH_INTERVAL_MS + 1
      expect(throttle.offer(`out ${i}`)).toBe(true)
    }
    expect(throttle.takePending()).toBeUndefined()
  })

  test("first chunk flushes immediately (leading edge)", () => {
    let now = 0
    const throttle = createStreamingMetadataThrottle(STREAMING_METADATA_FLUSH_INTERVAL_MS, () => now)
    expect(throttle.offer("first")).toBe(true)
    expect(throttle.takePending()).toBeUndefined()
    expect(throttle.offer("second")).toBe(false)
  })

  test("markFlushed clears pending and restarts the interval", () => {
    let now = 1000
    const throttle = createStreamingMetadataThrottle(STREAMING_METADATA_FLUSH_INTERVAL_MS, () => now)
    expect(throttle.offer("a")).toBe(true)
    now += 1
    expect(throttle.offer("b")).toBe(false)
    throttle.markFlushed()
    expect(throttle.pending).toBeUndefined()
    expect(throttle.takePending()).toBeUndefined()
    now += 1
    expect(throttle.offer("c")).toBe(false)
    now += STREAMING_METADATA_FLUSH_INTERVAL_MS
    expect(throttle.offer("d")).toBe(true)
  })
})

describe("streaming byte counter", () => {
  test("total matches the utf-8 length of all chunks", () => {
    const counter = createByteCounter()
    const chunks = ["hello", " wörld\n", "✓".repeat(100), ""]
    let expected = 0
    for (const chunk of chunks) {
      expected += Buffer.byteLength(chunk, "utf-8")
      expect(counter.add(chunk)).toBe(expected)
    }
    expect(counter.total).toBe(expected)
    expect(counter.total).toBe(Buffer.byteLength(chunks.join(""), "utf-8"))
  })

  test("reset drops the total back to zero", () => {
    const counter = createByteCounter()
    counter.add("some output")
    expect(counter.total).toBeGreaterThan(0)
    counter.reset()
    expect(counter.total).toBe(0)
    expect(counter.add("ab")).toBe(2)
  })
})

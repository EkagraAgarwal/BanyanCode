/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { SystemPanel, SYSTEM_PRIME_MS, SYSTEM_POLL_MS, type SystemPanelTimers } from "../src/components/sidebar/system-status"
import type { SystemStatus } from "../src/data/pending-rpc"
import { createLive } from "../src/data/live"
import { context, mount } from "./harness"

/**
 * The system sidebar is data, not animation: it must keep updating while it is
 * mounted even when no `banyancode.system.updated` push arrives, and it must
 * stop the moment it unmounts.
 */

const GB = 1024 ** 3

/** A per-call status. `cpuPercent` climbs with the call number so a frame change is unambiguous. */
const sample = (call: number): SystemStatus => ({
  cpuPercent: 10 + call * 10,
  memoryUsedBytes: (4 + call) * GB,
  memoryTotalBytes: 32 * GB,
  diskUsedBytes: 100 * GB,
  diskTotalBytes: 500 * GB,
  platform: "windows",
})

/** Deterministic timers, so "advance 6s" means exactly that. */
function fakeTimers() {
  let clock = 0
  let next = 1
  const timeouts = new Map<number, { at: number; run: () => void }>()
  const intervals = new Map<number, { every: number; at: number; run: () => void }>()
  const timers: SystemPanelTimers = {
    setTimeout: (handler, ms) => {
      const id = next++
      timeouts.set(id, { at: clock + ms, run: handler })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (handle) => {
      timeouts.delete(Number(handle))
    },
    setInterval: (handler, ms) => {
      const id = next++
      intervals.set(id, { every: ms, at: clock + ms, run: handler })
      return id as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: (handle) => {
      intervals.delete(Number(handle))
    },
  }
  return {
    timers,
    now: () => clock,
    pending: () => timeouts.size + intervals.size,
    advance(ms: number) {
      const target = clock + ms
      for (let guard = 0; guard < 1_000; guard++) {
        let due = Number.POSITIVE_INFINITY
        let fire: (() => void) | undefined
        let timeoutID: number | undefined
        let intervalID: number | undefined
        for (const [id, entry] of timeouts) {
          if (entry.at <= target && entry.at < due) {
            due = entry.at
            fire = entry.run
            timeoutID = id
            intervalID = undefined
          }
        }
        for (const [id, entry] of intervals) {
          if (entry.at <= target && entry.at < due) {
            due = entry.at
            fire = entry.run
            timeoutID = undefined
            intervalID = id
          }
        }
        if (fire === undefined) break
        clock = due
        if (timeoutID !== undefined) {
          timeouts.delete(timeoutID)
        } else if (intervalID !== undefined) {
          const entry = intervals.get(intervalID)!
          entry.at = clock + entry.every
        }
        fire()
      }
      clock = target
    },
  }
}

/** A plugin client whose `system.status` changes on every call and whose events can be pushed. */
function fakeClient() {
  const methods: string[] = []
  const listeners = new Map<string, (event: { readonly data: SystemStatus }) => void>()
  let statusCalls = 0
  const rpc = (definition: { readonly id: string }) =>
    new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "events") {
            return {
              subscribe: () => [],
              on: (name: string, handler: (event: { readonly data: SystemStatus }) => void) => {
                const key = `${definition.id}.${name}`
                listeners.set(key, handler)
                return () => listeners.delete(key)
              },
            }
          }
          return async () => {
            const key = `${definition.id}.${String(property)}`
            methods.push(key)
            return key === "banyancode.system.status" ? sample((statusCalls += 1)) : {}
          }
        },
      },
    )
  return {
    context: { ...context(), location: { directory: "D:/workspace" }, client: { rpc } } as unknown as Context,
    statusCalls: () => statusCalls,
    calls: () => methods.filter((method) => method === "banyancode.system.status").length,
    push: (status: SystemStatus) => listeners.get("banyancode.system.updated")!({ data: status }),
  }
}

const lineOf = (frame: string, label: string) => {
  const line = frame.split("\n").find((item) => item.trimStart().startsWith(label))
  if (line === undefined) throw new Error(`no sidebar row starts with ${label}`)
  return line
}

test("the mounted panel polls, so the frame changes even with no push event", async () => {
  const clock = fakeTimers()
  const client = fakeClient()
  const live = createLive(client.context)
  const app = await mount(
    () => (
      <box width={120}>
        <SystemPanel context={client.context} system={live.system} timers={clock.timers} />
      </box>
    ),
    { width: 120, height: 40 },
  )
  try {
    await app.renderOnce()
    await Bun.sleep(0)
    await app.renderOnce()

    // Exactly one read on mount: the host is not polled twice for one paint.
    expect(client.calls()).toBe(1)
    const first = lineOf(app.captureCharFrame(), "CPU")
    expect(first).toContain("20%")

    // +1s: the follow-up sample that gives the CPU row its delta.
    clock.advance(SYSTEM_PRIME_MS)
    await Bun.sleep(0)
    await app.renderOnce()
    expect(client.calls()).toBe(2)

    // +5s: the steady poll.
    clock.advance(SYSTEM_POLL_MS)
    await Bun.sleep(0)
    await app.renderOnce()
    expect(client.calls()).toBe(3)
    const latest = lineOf(app.captureCharFrame(), "CPU")
    expect(latest).toContain("40%")
    expect(latest).not.toBe(first)
    expect(lineOf(app.captureCharFrame(), "Memory")).toContain("7.0 GB")
  } finally {
    app.renderer.destroy()
    live.dispose()
  }
})

test("a push that repeats the polled sample does not re-render", async () => {
  const clock = fakeTimers()
  const client = fakeClient()
  const live = createLive(client.context)
  const app = await mount(
    () => (
      <box width={120}>
        <SystemPanel context={client.context} system={live.system} timers={clock.timers} />
      </box>
    ),
    { width: 120, height: 40 },
  )
  try {
    await app.renderOnce()
    await Bun.sleep(0)
    await app.renderOnce()
    const polled = app.captureCharFrame()

    // The sampler caches for a second, so a push in the same second carries the
    // numbers the poll just rendered: writing them again would flash the panel.
    client.push(sample(1))
    await app.renderOnce()
    expect(app.captureCharFrame()).toBe(polled)

    // A genuinely new sample still lands.
    client.push(sample(4))
    await app.renderOnce()
    expect(lineOf(app.captureCharFrame(), "CPU")).toContain("50%")
  } finally {
    app.renderer.destroy()
    live.dispose()
  }
})

test("unmounting stops the poll", async () => {
  const clock = fakeTimers()
  const client = fakeClient()
  const live = createLive(client.context)
  const app = await mount(
    () => (
      <box width={120}>
        <SystemPanel context={client.context} system={live.system} timers={clock.timers} />
      </box>
    ),
    { width: 120, height: 40 },
  )
  try {
    await app.renderOnce()
    await Bun.sleep(0)
    expect(client.calls()).toBe(1)
    expect(clock.pending()).toBe(2)
  } finally {
    app.renderer.destroy()
    live.dispose()
  }

  expect(clock.pending()).toBe(0)
  clock.advance(20_000)
  await Bun.sleep(0)
  expect(client.calls()).toBe(1)
})

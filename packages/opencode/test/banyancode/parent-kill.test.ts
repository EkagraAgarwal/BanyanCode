import { describe, expect, test } from "bun:test"
import { createParentKill, KILL_ESCALATION_MS, watchParentCtrlC } from "../../src/cli/tui/parent-kill"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"

function makeController(opts: { windowMs?: number; onCancel?: () => void; onKill?: () => void } = {}) {
  const events: string[] = []
  let t = 0
  const kill = createParentKill({
    windowMs: opts.windowMs,
    now: () => t++,
    onCancel: () => {
      events.push("cancel")
      opts.onCancel?.()
    },
    onKill: () => {
      events.push("kill")
      opts.onKill?.()
    },
  })
  return { kill, events }
}

describe("createParentKill", () => {
  test("unarmed controller ignores Ctrl+C", () => {
    const { kill, events } = makeController()
    kill.onRawCtrlC()
    kill.onRawCtrlC()
    expect(events).toEqual([])
  })

  test("first press fires cancel; second press within window kills", () => {
    const { kill, events } = makeController()
    kill.setArmed(true)
    kill.onRawCtrlC()
    kill.onRawCtrlC()
    expect(events).toEqual(["cancel", "kill"])
    kill.dispose()
  })

  test("cancel acknowledged within window resets escalation", () => {
    const { kill, events } = makeController()
    kill.setArmed(true)
    kill.onRawCtrlC()
    expect(events).toEqual(["cancel"])
    kill.cancelAcked()
    // A second press after ack is treated as a fresh first press (cancel
    // again), not a kill — a responsive worker should never be hard-killed
    // by a stray second press.
    kill.onRawCtrlC()
    expect(events).toEqual(["cancel", "cancel"])
  })

  test("presses separated by more than the window start fresh", () => {
    let now = 0
    const events: string[] = []
    const kill = createParentKill({
      windowMs: 100,
      now: () => now,
      onCancel: () => {
        events.push("cancel")
      },
      onKill: () => {
        events.push("kill")
      },
    })
    kill.setArmed(true)
    kill.onRawCtrlC()
    now = 101
    kill.onRawCtrlC()
    expect(events).toEqual(["cancel", "cancel"])
    kill.dispose()
  })

  test("unacknowledged cancel escalates to kill after the window", async () => {
    const { kill, events } = makeController({ windowMs: 30 })
    kill.setArmed(true)
    kill.onRawCtrlC()
    expect(events).toEqual(["cancel"])
    await Bun.sleep(80)
    expect(events).toEqual(["cancel", "kill"])
  })

  test("acknowledged cancel does not kill after the window", async () => {
    const { kill, events } = makeController({ windowMs: 30 })
    kill.setArmed(true)
    kill.onRawCtrlC()
    kill.cancelAcked()
    await Bun.sleep(80)
    expect(events).toEqual(["cancel"])
  })

  test("disarm cancels the pending kill timer", async () => {
    const { kill, events } = makeController({ windowMs: 30 })
    kill.setArmed(true)
    kill.onRawCtrlC()
    kill.setArmed(false)
    await Bun.sleep(80)
    expect(events).toEqual(["cancel"])
  })

  test("dispose stops all escalation", async () => {
    const { kill, events } = makeController({ windowMs: 30 })
    kill.setArmed(true)
    kill.onRawCtrlC()
    kill.dispose()
    await Bun.sleep(80)
    expect(events).toEqual(["cancel"])
  })
})

describe("watchParentCtrlC", () => {
  test("forwards ctrl+c bytes and stops on unsubscribe", () => {
    const { kill, events } = makeController()
    const stdin = new EventEmitter() as NodeJS.ReadableStream
    const off = watchParentCtrlC(kill, { stdin })
    kill.setArmed(true)

    stdin.emit("data", Buffer.from("abc\u0003def"))
    expect(events).toEqual(["cancel"])

    // Second ctrl+c byte in the same window -> kill (the ack never arrived).
    stdin.emit("data", Buffer.from([0x03]))
    expect(events).toEqual(["cancel", "kill"])

    off()
    stdin.emit("data", Buffer.from([0x03]))
    expect(events).toEqual(["cancel", "kill"])
    kill.dispose()
  })
})

test("KILL_ESCALATION_MS is 2s", () => {
  expect(KILL_ESCALATION_MS).toBe(2_000)
})

describe("parent kill path with a blocked worker", () => {
  test("Ctrl+C escalates to a hard kill while the worker busy-loops and never acks", async () => {
    const workerPath = join(tmpdir(), `busy-worker-${Date.now()}.ts`)
    await Bun.write(
      workerPath,
      `
        // Simulates a wedged worker: never respond to messages and never
        // yield to the event loop.
        onmessage = () => {}
        const start = Date.now()
        while (Date.now() - start < 60_000) {}
      `,
    )
    const worker = new Worker(workerPath)
    try {
      const events: string[] = []
      const kill = createParentKill({
        windowMs: 40,
        now: Date.now,
        onCancel: () => {
          events.push("cancel")
          // Mirrors tui.ts: fire the cancel RPC at the worker; it can never
          // be acknowledged because the worker thread is busy-looping.
          worker.postMessage("cancel")
        },
        onKill: () => events.push("kill"),
      })
      kill.setArmed(true)
      kill.onRawCtrlC()
      expect(events).toEqual(["cancel"])

      // The worker never responds — after the escalation window the parent
      // must hard-kill on its own, without any worker cooperation.
      await Bun.sleep(120)
      expect(events).toEqual(["cancel", "kill"])
      kill.dispose()
    } finally {
      worker.terminate()
    }
  })
})

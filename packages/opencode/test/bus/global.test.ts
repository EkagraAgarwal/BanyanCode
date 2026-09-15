import { afterEach, describe, expect, it } from "bun:test"
import { GlobalBus, type GlobalEvent } from "@/bus/global"

describe("GlobalBus", () => {
  const listeners: Array<(event: GlobalEvent) => void> = []
  afterEach(() => {
    for (const listener of listeners.splice(0)) GlobalBus.off("event", listener)
  })
  const subscribe = (listener: (event: GlobalEvent) => void) => {
    listeners.push(listener)
    GlobalBus.on("event", listener)
  }

  it("delivers emitted events to subscribers", () => {
    const seen: GlobalEvent[] = []
    subscribe((event) => seen.push(event))
    expect(GlobalBus.emit("event", { payload: { type: "ping" } })).toBe(true)
    expect(seen.length).toBe(1)
    expect(seen[0].payload.type).toBe("ping")
  })

  it("stamps payload.id when missing", () => {
    const seen: GlobalEvent[] = []
    subscribe((event) => seen.push(event))
    GlobalBus.emit("event", { payload: { type: "ping" } })
    expect(typeof seen[0].payload.id).toBe("string")
  })

  it("reuses syncEvent.id for the stamp", () => {
    const seen: GlobalEvent[] = []
    subscribe((event) => seen.push(event))
    GlobalBus.emit("event", { payload: { type: "sync", syncEvent: { id: "evt_keep" } } })
    expect(seen[0].payload.id).toBe("evt_keep")
  })

  it("preserves a pre-existing payload id", () => {
    const seen: GlobalEvent[] = []
    subscribe((event) => seen.push(event))
    GlobalBus.emit("event", { payload: { type: "x", id: "evt_have" } })
    expect(seen[0].payload.id).toBe("evt_have")
  })

  it("stops delivering after off", () => {
    const seen: GlobalEvent[] = []
    const listener = (event: GlobalEvent) => seen.push(event)
    GlobalBus.on("event", listener)
    GlobalBus.off("event", listener)
    GlobalBus.emit("event", { payload: { type: "ping" } })
    expect(seen.length).toBe(0)
  })
})

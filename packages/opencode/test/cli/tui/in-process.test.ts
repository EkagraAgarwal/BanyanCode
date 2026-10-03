import { describe, expect, test } from "bun:test"
import {
  IN_PROCESS_ENV,
  InProcessConnectionError,
  createInProcessEventSource,
  createInProcessFetch,
  createInProcessTransport,
  isInProcessMode,
} from "../../../src/cli/tui/in-process"

class FakeBus {
  private handlers = new Set<(event: any) => void>()
  on(_name: "event", handler: (event: any) => void) {
    this.handlers.add(handler)
    return this as any
  }
  off(_name: "event", handler: (event: any) => void) {
    this.handlers.delete(handler)
    return this as any
  }
  emit(_name: "event", event: any) {
    for (const handler of [...this.handlers]) handler(event)
    return true
  }
  get size() {
    return this.handlers.size
  }
}

function textDelta(sessionID: string, textID: string, delta: string) {
  return {
    directory: "/tmp/opencode",
    project: "proj_test",
    payload: {
      id: `evt_${delta}`,
      type: "session.next.text.delta",
      properties: { sessionID, assistantMessageID: "msg_1", textID, delta, timestamp: 1 },
    },
  }
}

function syncCopy() {
  return {
    directory: "/tmp/opencode",
    project: "proj_test",
    payload: {
      type: "sync",
      syncEvent: { id: "evt_1", type: "session.next.text.delta", seq: 1, aggregateID: "ses_1", data: {} },
    },
  }
}

function textEnded(sessionID: string) {
  return {
    directory: "/tmp/opencode",
    project: "proj_test",
    payload: {
      id: "evt_end",
      type: "session.next.text.ended",
      properties: { sessionID, assistantMessageID: "msg_1", textID: "part_1", text: "hello", timestamp: 2 },
    },
  }
}

describe("in-process flag (default off)", () => {
  test("isInProcessMode is strict: only \"1\" enables", () => {
    expect(isInProcessMode({ [IN_PROCESS_ENV]: "1" } as any)).toBe(true)
    for (const value of [undefined, "", "0", "true", "TRUE", "yes"]) {
      const env = value === undefined ? ({} as any) : ({ [IN_PROCESS_ENV]: value } as any)
      expect(isInProcessMode(env)).toBe(false)
    }
  })

  test("worker path stays the default in tui.ts", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()
    // Default path intact: still spawns the worker, still uses the Rpc client.
    expect(source).toContain("new Worker(file)")
    expect(source).toContain("Rpc.client<typeof rpc>(worker)")
    // Flag-gated branch: strict env check + lazy in-process transport.
    expect(source).toContain("BANYANCODE_TUI_IN_PROCESS")
    expect(source).toContain('await import("../tui/in-process")')
  })
})

describe("in-process event protocol (worker parity)", () => {
  test("drops sync duplicates, passes everything else without a filter", async () => {
    const bus = new FakeBus()
    const events = createInProcessEventSource({ bus: bus as any })
    try {
      const seen: any[] = []
      await events.subscribe((e) => seen.push(e))
      bus.emit("event", syncCopy())
      const delta = textDelta("ses_1", "part_1", "hi")
      bus.emit("event", delta)
      events.setVisibleSessions // touch for coverage parity with worker envelope semantics
      // Delta is buffered by the coalescer; flush via a boundary event.
      bus.emit("event", textEnded("ses_1"))
      expect(seen.length).toBe(2)
      expect(seen[0].payload.properties.delta).toBe("hi")
      expect(seen[1].payload.type).toBe("session.next.text.ended")
    } finally {
      events.dispose()
    }
  })

  test("visible filter drops off-screen sessions, passes visible + global", async () => {
    const bus = new FakeBus()
    const events = createInProcessEventSource({ bus: bus as any })
    try {
      const seen: any[] = []
      await events.subscribe((e) => seen.push(e))
      events.setVisibleSessions(["ses_1"])
      bus.emit("event", textDelta("ses_2", "part_1", "x"))
      bus.emit("event", textEnded("ses_2"))
      bus.emit("event", textDelta("ses_1", "part_1", "y"))
      bus.emit("event", {
        payload: { id: "e", type: "installation.update-available", properties: {} },
      })
      bus.emit("event", textEnded("ses_1"))
      // ses_2 dropped (delta + ended), ses_1 delta + ended + global pass.
      expect(seen.map((e) => e.payload.type)).toEqual([
        "session.next.text.delta",
        "installation.update-available",
        "session.next.text.ended",
      ])
    } finally {
      events.dispose()
    }
  })

  test("merges per-token deltas for the same part into one emission", async () => {
    const bus = new FakeBus()
    const events = createInProcessEventSource({ bus: bus as any })
    try {
      const seen: any[] = []
      await events.subscribe((e) => seen.push(e))
      bus.emit("event", textDelta("ses_1", "part_1", "hel"))
      bus.emit("event", textDelta("ses_1", "part_1", "lo"))
      expect(seen.length).toBe(0)
      bus.emit("event", textEnded("ses_1"))
      expect(seen.length).toBe(2)
      expect(seen[0].payload.properties.delta).toBe("hello")
    } finally {
      events.dispose()
    }
  })

  test("setVisibleSessions filters non-strings, malformed input keeps the filter", async () => {
    const bus = new FakeBus()
    const events = createInProcessEventSource({ bus: bus as any })
    try {
      const seen: any[] = []
      await events.subscribe((e) => seen.push(e))
      events.setVisibleSessions(["ses_1", 42 as any, null as any])
      bus.emit("event", textDelta("ses_1", "part_1", "a"))
      // Malformed input must not clear the active filter.
      events.setVisibleSessions("nope" as any)
      bus.emit("event", textDelta("ses_2", "part_1", "b"))
      bus.emit("event", textEnded("ses_1"))
      expect(seen.map((e) => e.payload.properties?.sessionID)).toEqual(["ses_1", "ses_1"])
    } finally {
      events.dispose()
    }
  })

  test("unclassifiable envelopes are never dropped", async () => {
    const bus = new FakeBus()
    const events = createInProcessEventSource({ bus: bus as any })
    try {
      const seen: any[] = []
      await events.subscribe((e) => seen.push(e))
      events.setVisibleSessions(["ses_1"])
      for (const malformed of [null, undefined, 42, "x", {}, { payload: null }]) {
        bus.emit("event", malformed as any)
      }
      expect(seen.length).toBe(6)
    } finally {
      events.dispose()
    }
  })

  test("unsubscribe stops delivery, dispose unsubscribes from the bus", async () => {
    const bus = new FakeBus()
    const events = createInProcessEventSource({ bus: bus as any })
    const seen: any[] = []
    const unsub = await events.subscribe((e) => seen.push(e))
    expect(bus.size).toBe(1)
    unsub()
    bus.emit("event", { payload: { id: "e", type: "ping", properties: {} } })
    expect(seen.length).toBe(0)
    events.dispose()
    expect(bus.size).toBe(0)
  })
})

describe("in-process fetch + isolation", () => {
  test("fetch injects the auth header and serves via app.fetch", async () => {
    const requests: Request[] = []
    const fetch = createInProcessFetch({
      authHeader: () => "Bearer secret",
      appFetch: async (request) => {
        requests.push(request)
        return new Response("ok", { status: 201, headers: { "x-test": "1" } })
      },
    })
    const response = await fetch("http://opencode.internal/session", { method: "POST", body: "{}" })
    expect(response.status).toBe(201)
    expect(response.headers.get("x-test")).toBe("1")
    expect(await response.text()).toBe("ok")
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer secret")
  })

  test("fetch defect surfaces as a recoverable connection error (non-fatal)", async () => {
    const reported: unknown[] = []
    const fetch = createInProcessFetch({
      onError: (error) => reported.push(error),
      authHeader: () => undefined,
      appFetch: async () => {
        throw new Error("defect")
      },
    })
    const error = await fetch("http://opencode.internal/session").then(
      () => null,
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(InProcessConnectionError)
    expect((error as InProcessConnectionError).recoverable).toBe(true)
    expect(reported.length).toBe(1)
  })

  test("one throwing subscriber does not break the others or the subscription", async () => {
    const bus = new FakeBus()
    const reported: unknown[] = []
    const events = createInProcessEventSource({ bus: bus as any, onError: (error) => reported.push(error) })
    try {
      const seen: any[] = []
      await events.subscribe(() => {
        throw new Error("subscriber defect")
      })
      await events.subscribe((e) => seen.push(e))
      bus.emit("event", { payload: { id: "e", type: "ping", properties: {} } })
      expect(seen.length).toBe(1)
      expect(reported.length).toBe(1)
      // Subscription survives the defect: the next event still arrives.
      bus.emit("event", { payload: { id: "e2", type: "ping", properties: {} } })
      expect(seen.length).toBe(2)
    } finally {
      events.dispose()
    }
  })
})

describe("in-process smoke (flag-gated transport end-to-end)", () => {
  test("transport serves fetch + filtered events without a Worker", async () => {
    const bus = new FakeBus()
    let disposed = 0
    const transport = createInProcessTransport({
      bus: bus as any,
      authHeader: () => undefined,
      disposeInstances: async () => {
        disposed += 1
      },
      appFetch: async (request) => new Response(`served:${request.method}`, { status: 200 }),
    })
    try {
      // Events: same envelope semantics, including setVisibleSessions.
      const seen: any[] = []
      await transport.events.subscribe((e) => seen.push(e))
      transport.events.setVisibleSessions(["ses_1"])
      bus.emit("event", textDelta("ses_1", "part_1", "hel"))
      bus.emit("event", textDelta("ses_1", "part_1", "lo"))
      bus.emit("event", textEnded("ses_1"))
      expect(seen.length).toBe(2)
      expect(seen[0].payload.properties.delta).toBe("hello")

      // Fetch: direct app.fetch, no thread hop.
      const response = await transport.fetch("http://opencode.internal/global/event", { method: "GET" })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("served:GET")

      // Shutdown is best-effort and disposes the event source.
      await transport.shutdown()
      expect(bus.size).toBe(0)
      expect(disposed).toBe(1)
    } finally {
      transport.events.dispose()
    }
  })
})

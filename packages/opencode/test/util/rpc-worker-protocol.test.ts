import { describe, expect, test } from "bun:test"
import {
  COALESCE_WINDOW_MS,
  Rpc,
  createCoalescer,
  deltaKey,
  eventSessionID,
  isSyncEnvelope,
  mergeDelta,
  shouldForward,
} from "../../src/util/rpc"

class FakeWorker {
  posted: unknown[] = []
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null = null
  postMessage(data: unknown): void {
    this.posted.push(data)
  }
  deliver(data: unknown): void {
    if (!this.onmessage) return
    this.onmessage.call(this as unknown as Worker, { data } as MessageEvent)
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

describe("Rpc structured-clone transport (backward compatible)", () => {
  test("client posts rpc.request as an object, not a JSON string", () => {
    const worker = new FakeWorker()
    const client = Rpc.client<{ ping: (input: { x: number }) => { ok: true } }>(worker)
    void client.call("ping", { x: 1 }).catch(() => {})
    expect(worker.posted.length).toBe(1)
    expect(typeof worker.posted[0]).toBe("object")
    expect(worker.posted[0]).toEqual({ type: "rpc.request", method: "ping", input: { x: 1 }, id: 0 })
  })

  test("client resolves rpc.result delivered as an object", async () => {
    const worker = new FakeWorker()
    const client = Rpc.client<{ ping: (input: { x: number }) => { ok: true } }>(worker)
    const pending = client.call("ping", { x: 1 })
    worker.deliver({ type: "rpc.result", id: 0, result: { ok: true } })
    await expect(pending).resolves.toEqual({ ok: true })
  })

  test("client still resolves rpc.result delivered as a legacy JSON string", async () => {
    const worker = new FakeWorker()
    const client = Rpc.client<{ ping: (input: { x: number }) => { ok: true } }>(worker)
    const pending = client.call("ping", { x: 1 })
    worker.deliver(JSON.stringify({ type: "rpc.result", id: 0, result: { ok: true } }))
    await expect(pending).resolves.toEqual({ ok: true })
  })

  test("client routes rpc.event delivered as an object", () => {
    const worker = new FakeWorker()
    const client = Rpc.client<any>(worker)
    const seen: unknown[] = []
    client.on("global.event", (data: unknown) => seen.push(data))
    worker.deliver({ type: "rpc.event", event: "global.event", data: { hello: 1 } })
    expect(seen).toEqual([{ hello: 1 }])
  })

  test("client still routes rpc.event delivered as a legacy JSON string", () => {
    const worker = new FakeWorker()
    const client = Rpc.client<any>(worker)
    const seen: unknown[] = []
    client.on("global.event", (data: unknown) => seen.push(data))
    worker.deliver(JSON.stringify({ type: "rpc.event", event: "global.event", data: { hello: 1 } }))
    expect(seen).toEqual([{ hello: 1 }])
  })

  test("client ignores malformed inbound of either shape without throwing", () => {
    const worker = new FakeWorker()
    Rpc.client<any>(worker)
    worker.deliver("definitely not json")
    worker.deliver(12345)
    worker.deliver(null)
    worker.deliver(undefined)
    worker.deliver({ nope: true })
    worker.deliver([1, 2, 3])
    expect(worker.posted.length).toBe(0)
  })

  test("listen accepts an object request and replies with an object", async () => {
    const originalOnMessage = globalThis.onmessage
    const originalPostMessage = globalThis.postMessage
    Rpc.listen({ ping: (input: { x: number }) => ({ ok: true, x: input.x }) })
    const handler = globalThis.onmessage
    globalThis.onmessage = originalOnMessage
    try {
      const replies: unknown[] = []
      ;(globalThis as any).postMessage = (data: unknown) => replies.push(data)
      const worker = new FakeWorker()
      worker.onmessage = handler as unknown as FakeWorker["onmessage"]
      worker.deliver({ type: "rpc.request", method: "ping", input: { x: 2 }, id: 3 })
      await new Promise((r) => setTimeout(r, 10))
      expect(replies.length).toBe(1)
      expect(typeof replies[0]).toBe("object")
      expect(replies[0]).toEqual({ type: "rpc.result", result: { ok: true, x: 2 }, id: 3 })
    } finally {
      globalThis.onmessage = originalOnMessage
      globalThis.postMessage = originalPostMessage
    }
  })

  test("listen still accepts a legacy JSON-string request", async () => {
    const originalOnMessage = globalThis.onmessage
    const originalPostMessage = globalThis.postMessage
    Rpc.listen({ ping: () => ({ ok: true }) })
    const handler = globalThis.onmessage
    globalThis.onmessage = originalOnMessage
    try {
      const replies: unknown[] = []
      ;(globalThis as any).postMessage = (data: unknown) => replies.push(data)
      const worker = new FakeWorker()
      worker.onmessage = handler as unknown as FakeWorker["onmessage"]
      worker.deliver(JSON.stringify({ type: "rpc.request", method: "ping", input: {}, id: 4 }))
      await new Promise((r) => setTimeout(r, 10))
      expect(replies.length).toBe(1)
      const raw = replies[0]
      const reply = typeof raw === "string" ? JSON.parse(raw) : raw
      expect(reply).toEqual({ type: "rpc.result", result: { ok: true }, id: 4 })
    } finally {
      globalThis.onmessage = originalOnMessage
      globalThis.postMessage = originalPostMessage
    }
  })

  test("listen replies instead of hanging when the handler throws", async () => {
    const originalOnMessage = globalThis.onmessage
    const originalPostMessage = globalThis.postMessage
    Rpc.listen({
      boom: () => {
        throw new Error("kaboom")
      },
    })
    const handler = globalThis.onmessage
    globalThis.onmessage = originalOnMessage
    try {
      const replies: unknown[] = []
      ;(globalThis as any).postMessage = (data: unknown) => replies.push(data)
      const worker = new FakeWorker()
      worker.onmessage = handler as unknown as FakeWorker["onmessage"]
      worker.deliver({ type: "rpc.request", method: "boom", input: {}, id: 5 })
      await new Promise((r) => setTimeout(r, 10))
      expect(replies.length).toBe(1)
    } finally {
      globalThis.onmessage = originalOnMessage
      globalThis.postMessage = originalPostMessage
    }
  })

  test("emit posts an object, not a JSON string", () => {
    const originalPostMessage = globalThis.postMessage
    try {
      const sent: unknown[] = []
      ;(globalThis as any).postMessage = (data: unknown) => sent.push(data)
      Rpc.emit("global.event", { hello: 1 })
      expect(sent).toEqual([{ type: "rpc.event", event: "global.event", data: { hello: 1 } }])
    } finally {
      globalThis.postMessage = originalPostMessage
    }
  })
})

describe("worker event classifiers (pass-through on unknown shapes)", () => {
  test("isSyncEnvelope detects the duplicate sync copy only", () => {
    expect(isSyncEnvelope(syncCopy())).toBe(true)
    expect(isSyncEnvelope(textDelta("ses_1", "part_1", "hi"))).toBe(false)
    for (const malformed of [null, undefined, 42, "sync", {}, { payload: null }, { payload: {} }, []]) {
      expect(isSyncEnvelope(malformed)).toBe(false)
    }
  })

  test("eventSessionID extracts or degrades to undefined", () => {
    expect(eventSessionID(textDelta("ses_9", "part_1", "hi"))).toBe("ses_9")
    expect(eventSessionID(syncCopy())).toBe(undefined)
    for (const malformed of [null, undefined, 42, "x", {}, { payload: null }, { payload: { properties: null } }]) {
      expect(eventSessionID(malformed)).toBe(undefined)
    }
  })

  test("deltaKey keys mergeable deltas per part, undefined otherwise", () => {
    expect(deltaKey(textDelta("ses_1", "part_1", "a"))).toBe("session.next.text.delta:ses_1:part_1")
    expect(
      deltaKey({
        payload: {
          type: "session.next.reasoning.delta",
          properties: { sessionID: "ses_1", assistantMessageID: "m", reasoningID: "r_1", delta: "x" },
        },
      }),
    ).toBe("session.next.reasoning.delta:ses_1:r_1")
    expect(
      deltaKey({
        payload: {
          type: "session.next.tool.input.delta",
          properties: { sessionID: "ses_1", assistantMessageID: "m", callID: "call_1", delta: "x" },
        },
      }),
    ).toBe("session.next.tool.input.delta:ses_1:call_1")
    // Not mergeable: boundaries, other types, compaction (text field, not delta)
    expect(deltaKey(textEnded("ses_1"))).toBe(undefined)
    expect(deltaKey(syncCopy())).toBe(undefined)
    expect(
      deltaKey({
        payload: {
          type: "session.next.compaction.delta",
          properties: { sessionID: "ses_1", messageID: "m", text: "x" },
        },
      }),
    ).toBe(undefined)
    expect(deltaKey({ payload: { type: "session.next.text.delta", properties: { sessionID: "ses_1" } } })).toBe(
      undefined,
    )
    for (const malformed of [null, undefined, 42, "x", {}, { payload: 7 }]) {
      expect(deltaKey(malformed)).toBe(undefined)
    }
  })

  test("mergeDelta concatenates fragments (identical to sequential +=)", () => {
    const into = textDelta("ses_1", "part_1", "hel")
    mergeDelta(into, textDelta("ses_1", "part_1", "lo"))
    expect(into.payload.properties.delta).toBe("hello")
  })

  test("shouldForward drops sync + off-screen sessions, passes everything else", () => {
    const visible = new Set(["ses_1"])
    // Sync duplicates are always dropped, even for visible sessions.
    expect(shouldForward(syncCopy(), undefined)).toBe(false)
    expect(shouldForward(syncCopy(), visible)).toBe(false)
    // No filter info yet: pass everything through.
    expect(shouldForward(textDelta("ses_2", "part_1", "x"), undefined)).toBe(true)
    expect(shouldForward(textDelta("ses_2", "part_1", "x"), new Set())).toBe(true)
    // Active filter: visible session passes, others drop, global passes.
    expect(shouldForward(textDelta("ses_1", "part_1", "x"), visible)).toBe(true)
    expect(shouldForward(textDelta("ses_2", "part_1", "x"), visible)).toBe(false)
    expect(shouldForward(textEnded("ses_2"), visible)).toBe(false)
    expect(shouldForward({ payload: { id: "e", type: "installation.update-available", properties: {} } }, visible)).toBe(
      true,
    )
    // Unclassifiable envelopes are never dropped.
    for (const malformed of [null, undefined, 42, "x", {}, { payload: null }]) {
      expect(shouldForward(malformed, visible)).toBe(true)
    }
  })
})

describe("createCoalescer", () => {
  test("merges per-token deltas for the same part into one emission", async () => {
    const emitted: any[] = []
    const coalescer = createCoalescer((e) => emitted.push(e), 1000)
    coalescer.push("k1", textDelta("ses_1", "part_1", "hel"))
    coalescer.push("k1", textDelta("ses_1", "part_1", "lo"))
    expect(coalescer.size).toBe(1)
    expect(emitted.length).toBe(0)
    coalescer.flush()
    expect(emitted.length).toBe(1)
    expect(emitted[0].payload.properties.delta).toBe("hello")
  })

  test("keeps different parts separate", () => {
    const emitted: any[] = []
    const coalescer = createCoalescer((e) => emitted.push(e), 1000)
    coalescer.push("k1", textDelta("ses_1", "part_1", "a"))
    coalescer.push("k2", textDelta("ses_1", "part_2", "b"))
    expect(coalescer.size).toBe(2)
    coalescer.flush()
    expect(emitted.length).toBe(2)
  })

  test("flushes on the window timer", async () => {
    const emitted: any[] = []
    const coalescer = createCoalescer((e) => emitted.push(e), 5)
    coalescer.push("k1", textDelta("ses_1", "part_1", "a"))
    await new Promise((r) => setTimeout(r, 50))
    expect(emitted.length).toBe(1)
    expect(emitted[0].payload.properties.delta).toBe("a")
  })

  test("default window matches the ~33ms design target", () => {
    expect(COALESCE_WINDOW_MS).toBe(33)
  })
})

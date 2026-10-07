import { describe, expect, test } from "bun:test"
import { Rpc } from "../../src/util/rpc"

class FakeWorker {
  posted: string[] = []
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null = null
  postMessage(data: string): void {
    this.posted.push(data)
  }
  deliver(data: unknown): void {
    if (!this.onmessage) return
    this.onmessage.call(this as unknown as Worker, { data } as MessageEvent)
  }
}

describe("Rpc malformed-input hardening", () => {
  test("client ignores malformed JSON without throwing", () => {
    const worker = new FakeWorker()
    Rpc.client<any>(worker)
    worker.deliver("definitely not json")
    worker.deliver(12345)
    worker.deliver(null)
    worker.deliver({ type: "rpc.result", id: 1, result: { ok: true } })
    expect(worker.posted.length).toBe(0)
  })

  test("client routes a valid rpc.result to the pending resolver", async () => {
    const worker = new FakeWorker()
    const client = Rpc.client<{ ping: (input: { x: number }) => { ok: true } }>(worker)
    const pending = client.call("ping", { x: 1 })
    worker.deliver(JSON.stringify({ type: "rpc.result", id: 0, result: { ok: true } }))
    await expect(pending).resolves.toEqual({ ok: true })
  })

  test("client drops rpc.result with a non-numeric id without throwing", () => {
    const worker = new FakeWorker()
    Rpc.client<any>(worker)
    worker.deliver(JSON.stringify({ type: "rpc.result", id: "abc", result: { ok: true } }))
    expect(worker.posted.length).toBe(0)
  })
})

describe("Rpc.listen malformed-input hardening", () => {
  test("listen survives malformed JSON without dispatching", async () => {
    const worker = new FakeWorker()
    const seen: string[] = []
    const originalOnMessage = globalThis.onmessage
    Rpc.listen({
      ping: () => {
        seen.push("ping")
        return "pong"
      },
    })
    const handler = globalThis.onmessage
    globalThis.onmessage = originalOnMessage
    try {
      // Wire the registered handler to our FakeWorker so we can deliver
      // malformed payloads via the worker's onmessage pathway.
      worker.onmessage = handler as unknown as FakeWorker["onmessage"]
      expect(() => worker.deliver("not valid json")).not.toThrow()
      expect(() => worker.deliver(12345)).not.toThrow()
      expect(() => worker.deliver(null)).not.toThrow()
      expect(seen).toEqual([])
      expect(worker.posted.length).toBe(0)
    } finally {
      globalThis.onmessage = originalOnMessage
    }
  })

  test("listen ignores rpc.request whose method is unknown", async () => {
    const worker = new FakeWorker()
    const seen: string[] = []
    const originalOnMessage = globalThis.onmessage
    Rpc.listen({
      ping: () => {
        seen.push("ping")
        return "pong"
      },
    })
    const handler = globalThis.onmessage
    globalThis.onmessage = originalOnMessage
    try {
      worker.onmessage = handler as unknown as FakeWorker["onmessage"]
      worker.deliver(JSON.stringify({ type: "rpc.request", method: "doesNotExist", input: {}, id: 7 }))
      expect(seen).toEqual([])
      expect(worker.posted.length).toBe(0)
    } finally {
      globalThis.onmessage = originalOnMessage
    }
  })

  test("listen ignores rpc.request whose method is not a string", async () => {
    const worker = new FakeWorker()
    const seen: string[] = []
    const originalOnMessage = globalThis.onmessage
    Rpc.listen({
      ping: () => {
        seen.push("ping")
        return "pong"
      },
    })
    const handler = globalThis.onmessage
    globalThis.onmessage = originalOnMessage
    try {
      worker.onmessage = handler as unknown as FakeWorker["onmessage"]
      worker.deliver(JSON.stringify({ type: "rpc.request", method: 42, input: {}, id: 8 }))
      expect(seen).toEqual([])
      expect(worker.posted.length).toBe(0)
    } finally {
      globalThis.onmessage = originalOnMessage
    }
  })

  test("listen dispatches a valid rpc.request and posts the result", async () => {
    const worker = new FakeWorker()
    const seen: string[] = []
    const originalOnMessage = globalThis.onmessage
    const originalPostMessage = globalThis.postMessage
    Rpc.listen({
      ping: (input: { x: number }) => {
        seen.push(`ping:${input.x}`)
        return { ok: true }
      },
    })
    const handler = globalThis.onmessage
    globalThis.onmessage = originalOnMessage
    try {
      // Stub postMessage so the worker's reply goes into our FakeWorker.
      const replyWorker = new FakeWorker()
      ;(globalThis as any).postMessage = (data: string) => replyWorker.postMessage(data)
      worker.onmessage = handler as unknown as FakeWorker["onmessage"]
      worker.deliver(JSON.stringify({ type: "rpc.request", method: "ping", input: { x: 1 }, id: 9 }))
      await new Promise((r) => setTimeout(r, 10))
      expect(seen).toEqual(["ping:1"])
      expect(replyWorker.posted.length).toBe(1)
      const reply = JSON.parse(replyWorker.posted[0]!)
      expect(reply).toEqual({ type: "rpc.result", result: { ok: true }, id: 9 })
    } finally {
      globalThis.onmessage = originalOnMessage
      globalThis.postMessage = originalPostMessage
    }
  })
})


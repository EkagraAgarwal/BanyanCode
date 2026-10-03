type Definition = {
  [method: string]: (input: any) => any
}

// Inbound may be a JSON string (legacy producers) or a structured-clone
// object (current postMessage(object) producers). Return null on malformed
// data so the worker/client socket stays alive instead of throwing on bad
// input. Unknown shapes degrade to null (dropped at this layer); callers
// that forward events must treat unclassifiable envelopes as pass-through.
function safeParse(data: unknown): any | null {
  if (typeof data === "string") {
    try {
      return JSON.parse(data)
    } catch {
      return null
    }
  }
  if (data !== null && typeof data === "object") return data
  return null
}

export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    const parsed = safeParse(evt.data)
    if (!parsed || typeof parsed !== "object") return
    if (parsed.type === "rpc.request" && typeof parsed.method === "string") {
      const handler = rpc[parsed.method]
      if (typeof handler !== "function") return
      let result: unknown
      try {
        result = await handler(parsed.input)
      } catch (error) {
        // Reply instead of letting an unhandled rejection abort the worker;
        // callers already tolerate undefined results via timeout/catch.
        console.error("[rpc] handler failed", parsed.method, error instanceof Error ? error.message : String(error))
        result = undefined
      }
      try {
        postMessage({ type: "rpc.result", result, id: parsed.id })
      } catch (error) {
        console.error("[rpc] postMessage failed", error instanceof Error ? error.message : String(error))
      }
    }
  }
}

export function emit(event: string, data: unknown) {
  try {
    postMessage({ type: "rpc.event", event, data })
  } catch (error) {
    console.error("[rpc] postMessage failed", error instanceof Error ? error.message : String(error))
  }
}

export function client<T extends Definition>(target: {
  postMessage: (data: any) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
}) {
  const pending = new Map<number, (result: any) => void>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  target.onmessage = async (evt) => {
    const parsed = safeParse(evt.data)
    if (!parsed || typeof parsed !== "object") return
    if (parsed.type === "rpc.result" && typeof parsed.id === "number") {
      const resolve = pending.get(parsed.id)
      if (resolve) {
        resolve(parsed.result)
        pending.delete(parsed.id)
      }
    }
    if (parsed.type === "rpc.event" && typeof parsed.event === "string") {
      const handlers = listeners.get(parsed.event)
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data)
        }
      }
    }
  }
  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      const requestId = id++
      return new Promise((resolve) => {
        pending.set(requestId, resolve)
        target.postMessage({ type: "rpc.request", method, input, id: requestId })
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
  }
}

// --- TUI worker event protocol -------------------------------------------
// The worker forwards GlobalBus envelopes ({ directory?, project?,
// workspace?, payload: { id, type, properties } }) to the TUI thread. To
// avoid pushing every session's per-token traffic across the Worker
// boundary, the worker filters and coalesces before Rpc.emit. All helpers
// are pure so they stay testable without booting the worker; anything they
// cannot classify returns the pass-through answer (never drop what you
// cannot understand).

export const WORKER_EVENT = "global.event"
export const COALESCE_WINDOW_MS = 33

const MERGEABLE_DELTA_TYPES = new Set([
  "session.next.text.delta",
  "session.next.reasoning.delta",
  "session.next.tool.input.delta",
])

function envelopePayload(event: unknown): { type?: unknown; properties?: unknown } | undefined {
  if (!event || typeof event !== "object") return undefined
  const payload = (event as { payload?: unknown }).payload
  if (!payload || typeof payload !== "object") return undefined
  return payload as { type?: unknown; properties?: unknown }
}

// Duplicate envelope emitted beside every syncable event (see
// event-v2-bridge.ts). The TUI drops these downstream too; skipping them
// here keeps the duplicate copy off the Worker boundary entirely.
export function isSyncEnvelope(event: unknown): boolean {
  return envelopePayload(event)?.type === "sync"
}

export function eventSessionID(event: unknown): string | undefined {
  const properties = envelopePayload(event)?.properties
  if (!properties || typeof properties !== "object") return undefined
  const sessionID = (properties as { sessionID?: unknown }).sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

// Coalesce key for mergeable string deltas, or undefined when the envelope
// is not a mergeable delta (pass through untouched).
export function deltaKey(event: unknown): string | undefined {
  const payload = envelopePayload(event)
  if (typeof payload?.type !== "string" || !MERGEABLE_DELTA_TYPES.has(payload.type)) return undefined
  const properties = payload.properties
  if (!properties || typeof properties !== "object") return undefined
  const props = properties as Record<string, unknown>
  if (typeof props.sessionID !== "string" || typeof props.delta !== "string") return undefined
  const partID = props.textID ?? props.reasoningID ?? props.callID
  if (typeof partID !== "string") return undefined
  return `${payload.type}:${props.sessionID as string}:${partID}`
}

export function mergeDelta(into: any, incoming: any): any {
  into.payload.properties.delta += incoming.payload.properties.delta as string
  return into
}

// Worker-side admission: drop sync duplicates and session events outside
// the visible set. `visible === undefined` (or empty) means the TUI has not
// told the worker what is displayed yet — pass everything through.
// Envelopes without a sessionID (global events) always pass through.
export function shouldForward(event: unknown, visible: Set<string> | undefined): boolean {
  if (isSyncEnvelope(event)) return false
  if (!visible || visible.size === 0) return true
  const sessionID = eventSessionID(event)
  if (sessionID === undefined) return true
  return visible.has(sessionID)
}

export function createCoalescer(
  emitFn: (event: any) => void,
  windowMs: number = COALESCE_WINDOW_MS,
): {
  push: (key: string, event: any) => void
  flush: () => void
  readonly size: number
} {
  const pending = new Map<string, any>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (pending.size === 0) return
    const events = [...pending.values()]
    pending.clear()
    for (const event of events) emitFn(event)
  }
  return {
    push: (key: string, event: any) => {
      const existing = pending.get(key)
      if (existing) mergeDelta(existing, event)
      else pending.set(key, event)
      if (timer === undefined) timer = setTimeout(flush, windowMs)
    },
    flush,
    get size() {
      return pending.size
    },
  }
}

export * as Rpc from "./rpc"

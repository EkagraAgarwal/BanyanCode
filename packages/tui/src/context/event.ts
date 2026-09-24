import type { Event } from "@opencode-ai/sdk/v2"
import { useSDK } from "./sdk"

type EventMetadata = {
  workspace: string | undefined
}

type Handler = (event: Event, metadata: EventMetadata) => void

type Dispatcher = {
  byType: Map<string, Set<Handler>>
  wildcard: Set<Handler>
  unsub: (() => void) | undefined
}

// One typed dispatcher per SDK event bus so every useEvent().on(type)
// shares a single fan-in instead of each handler waking on every SSE event.
const dispatchers = new WeakMap<object, Dispatcher>()

function getDispatcher(bus: object): Dispatcher {
  const existing = dispatchers.get(bus)
  if (existing) return existing
  const created: Dispatcher = {
    byType: new Map(),
    wildcard: new Set(),
    unsub: undefined,
  }
  dispatchers.set(bus, created)
  return created
}

function invoke(handlers: Iterable<Handler>, event: Event, metadata: EventMetadata) {
  for (const handler of handlers) {
    try {
      handler(event, metadata)
    } catch (error) {
      console.error("tui event handler failed", {
        type: event.type,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

function ensureSubscribed(sdk: ReturnType<typeof useSDK>, dispatcher: Dispatcher) {
  if (dispatcher.unsub) return
  dispatcher.unsub = sdk.event.on("event", (event) => {
    if (event.payload.type === "sync") return
    const metadata = { workspace: event.workspace }
    invoke(dispatcher.wildcard, event.payload, metadata)
    const typed = dispatcher.byType.get(event.payload.type)
    if (!typed || typed.size === 0) return
    invoke(typed, event.payload, metadata)
  })
}

function maybeTeardown(dispatcher: Dispatcher) {
  if (dispatcher.wildcard.size > 0 || dispatcher.byType.size > 0) return
  dispatcher.unsub?.()
  dispatcher.unsub = undefined
}

export function useEvent() {
  const sdk = useSDK()
  const dispatcher = getDispatcher(sdk.event)

  function subscribe(handler: (event: Event, metadata: EventMetadata) => void) {
    ensureSubscribed(sdk, dispatcher)
    dispatcher.wildcard.add(handler)
    return () => {
      dispatcher.wildcard.delete(handler)
      maybeTeardown(dispatcher)
    }
  }

  function on<T extends Event["type"]>(
    type: T,
    handler: (event: Extract<Event, { type: T }>, metadata: EventMetadata) => void,
  ) {
    ensureSubscribed(sdk, dispatcher)
    let handlers = dispatcher.byType.get(type)
    if (!handlers) {
      handlers = new Set()
      dispatcher.byType.set(type, handlers)
    }
    handlers.add(handler as Handler)
    return () => {
      handlers!.delete(handler as Handler)
      if (handlers!.size === 0) dispatcher.byType.delete(type)
      maybeTeardown(dispatcher)
    }
  }

  return {
    subscribe,
    on,
  }
}

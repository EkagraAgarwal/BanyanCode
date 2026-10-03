import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Rpc } from "@/util/rpc"
import type { EventSource } from "@opencode-ai/tui/context/sdk"

export const IN_PROCESS_ENV = "BANYANCODE_TUI_IN_PROCESS"

// Feature flag for the V6 in-process TUI mode. Strict `"1"` check —
// anything else (unset, "0", "true") keeps the default worker path.
export function isInProcessMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[IN_PROCESS_ENV] === "1"
}

// Recoverable connection error. Thrown at the in-process boundary when a
// defect is caught so callers treat it exactly like a worker connection
// failure: log, keep the TUI alive, and let the next request retry fresh
// against re-initialized state.
export class InProcessConnectionError extends Error {
  readonly recoverable = true as const
  constructor(op: string, options?: { cause?: unknown }) {
    super(`[tui] in-process ${op} failed (recoverable connection error)`, options)
    this.name = "InProcessConnectionError"
  }
}

export type InProcessTransportOptions = {
  // Called non-fatally on every contained defect, mirroring the
  // `worker.onerror` philosophy in cli/cmd/tui.ts (stderr line is
  // acceptable, the file logger keeps the full crash, the TUI survives).
  onError?: (error: unknown) => void
  // Injectable app.fetch for tests. Defaults to Server.Default().app.fetch
  // via a lazy import so unit tests never boot the server graph.
  appFetch?: (request: Request) => Promise<Response>
  // Injectable auth header for tests. Defaults to ServerAuth.header().
  authHeader?: () => string | undefined
  // Injectable instance disposal for tests. Defaults to
  // InstanceRuntime.disposeAllInstances() via a lazy import so unit tests
  // never boot the instance graph.
  disposeInstances?: () => Promise<void>
  // Injectable GlobalBus for tests. Defaults to the real GlobalBus.
  bus?: Pick<typeof GlobalBus, "on" | "off" | "emit">
}

async function defaultAppFetch(request: Request): Promise<Response> {
  const { Server } = await import("@/server/server")
  return Server.Default().app.fetch(request)
}

async function defaultAuthHeader(): Promise<string | undefined> {
  const { ServerAuth } = await import("@/server/auth")
  return ServerAuth.header()
}

function report(options: InProcessTransportOptions, error: unknown) {
  try {
    options.onError?.(error)
  } catch {}
}

// In-process event source. Mirrors the worker-side protocol in
// cli/tui/worker.ts exactly: the same Rpc.shouldForward admission (sync
// duplicates dropped, off-screen sessions dropped once the TUI reports what
// is visible), the same Rpc.deltaKey per-part coalescing over the same
// ~33ms window with the same flush-before-boundary ordering, and the same
// setVisibleSessions envelope semantics (malformed input keeps the previous
// filter). The only difference is the transport: GlobalBus directly,
// no Worker hop.
export function createInProcessEventSource(
  options: InProcessTransportOptions = {},
): EventSource & { setVisibleSessions: (sessionIDs: string[]) => void; dispose: () => void } {
  const bus = options.bus ?? GlobalBus
  const visibleSessionIDs = new Set<string>()
  let hasVisibleFilter = false
  // `any` at the fan-out boundary: the bus envelope
  // (`@/bus/global` GlobalEvent, optional directory) and the SDK event
  // (`@opencode-ai/sdk/v2` GlobalEvent) differ in optional fields — the
  // same crossing the worker performs via structured clone.
  const handlers = new Set<(event: any) => void>()

  const forward = (event: any) => {
    for (const handler of [...handlers]) {
      try {
        handler(event)
      } catch (error) {
        // One throwing subscriber must not break the remaining handlers
        // or the GlobalBus subscription (which would stall every TUI update).
        report(options, error)
      }
    }
  }

  const coalescer = Rpc.createCoalescer((event: GlobalEvent) => {
    try {
      forward(event)
    } catch (error) {
      report(options, error)
    }
  })

  // State re-init: drop the admitted buffer and re-subscribe so a defect
  // in the subscription path recovers to a clean GlobalBus listener,
  // mirroring a worker restart without killing the process.
  const reinit = () => {
    try {
      coalescer.flush()
    } catch (error) {
      report(options, error)
    }
    try {
      bus.off("event", onGlobalEvent)
    } catch (error) {
      report(options, error)
    }
    try {
      bus.on("event", onGlobalEvent)
    } catch (error) {
      report(options, error)
      throw new InProcessConnectionError("event-source re-init", { cause: error })
    }
  }

  const onGlobalEvent = (event: GlobalEvent) => {
    let admit: boolean
    try {
      admit = Rpc.shouldForward(event, hasVisibleFilter ? visibleSessionIDs : undefined)
    } catch {
      // Degrade to pass-through, same as the worker: never drop what the
      // classifier cannot understand.
      admit = true
    }
    if (!admit) return
    try {
      const key = Rpc.deltaKey(event)
      if (key !== undefined) {
        coalescer.push(key, event)
        return
      }
      // Non-delta: flush buffered deltas first so ordering is preserved
      // (e.g. deltas before their `.ended` boundary event).
      coalescer.flush()
      forward(event)
    } catch (error) {
      // A coalescing failure must not drop the event or break this
      // subscriber. Re-init state, then degrade to pass-through.
      report(options, error)
      try {
        reinit()
      } catch (reinitError) {
        report(options, reinitError)
      }
      try {
        forward(event)
      } catch (forwardError) {
        report(options, forwardError)
      }
    }
  }

  try {
    bus.on("event", onGlobalEvent)
  } catch (error) {
    report(options, error)
    throw new InProcessConnectionError("event-source subscribe", { cause: error })
  }

  return {
    subscribe: async (handler) => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    // Same envelope semantics as the worker's `setVisibleSessions` RPC:
    // non-string entries are filtered, malformed input keeps the previous
    // filter, and the admitted buffer is flushed rather than held past the
    // filter change. Synchronous here (no Worker round-trip to time out).
    setVisibleSessions: (sessionIDs: string[]) => {
      try {
        const ids = Array.isArray(sessionIDs) ? sessionIDs.filter((id): id is string => typeof id === "string") : undefined
        if (ids === undefined) return
        visibleSessionIDs.clear()
        for (const id of ids) visibleSessionIDs.add(id)
        hasVisibleFilter = true
        coalescer.flush()
      } catch (error) {
        report(options, error)
      }
    },
    dispose: () => {
      try {
        coalescer.flush()
      } catch (error) {
        report(options, error)
      }
      try {
        bus.off("event", onGlobalEvent)
      } catch (error) {
        report(options, error)
      }
      handlers.clear()
    },
  }
}

// In-process fetch. Same request shape as the worker's `fetch` RPC
// (auth header injection, { status, headers, body } envelope) but served
// by Server.Default().app.fetch directly. Defects surface as a recoverable
// connection error so the SDK retries the next request fresh.
export function createInProcessFetch(options: InProcessTransportOptions = {}): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    try {
      const headers = new Headers(request.headers)
      const auth = options.authHeader ? options.authHeader() : await defaultAuthHeader()
      if (auth && !headers.has("authorization")) headers.set("Authorization", auth)
      const authed = new Request(request, { headers })
      const appFetch = options.appFetch ?? defaultAppFetch
      return await appFetch(authed)
    } catch (error) {
      report(options, error)
      throw new InProcessConnectionError("fetch", { cause: error })
    }
  }
  return fn as typeof fetch
}

export type InProcessTransport = {
  fetch: typeof fetch
  events: EventSource & { setVisibleSessions: (sessionIDs: string[]) => void; dispose: () => void }
  server: (input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) => Promise<{ url: string }>
  checkUpgrade: (input: { directory: string }) => Promise<void>
  reload: () => Promise<void>
  shutdown: () => Promise<void>
  snapshot: () => Promise<unknown>
}

export function createInProcessTransport(options: InProcessTransportOptions = {}): InProcessTransport {
  const events = createInProcessEventSource(options)
  const fetch = createInProcessFetch(options)
  let server: Awaited<ReturnType<typeof import("@/server/server").Server.listen>> | undefined

  return {
    fetch,
    events,
    async server(input) {
      try {
        const { Server } = await import("@/server/server")
        if (server) await server.stop(true)
        server = await Server.listen(input)
        return { url: server.url.toString() }
      } catch (error) {
        report(options, error)
        throw new InProcessConnectionError("server start", { cause: error })
      }
    },
    async checkUpgrade(input) {
      try {
        const { InstanceRuntime } = await import("@/project/instance-runtime")
        const { upgrade } = await import("@/cli/upgrade")
        await InstanceRuntime.load({ directory: input.directory })
        await upgrade().catch(() => {})
      } catch (error) {
        report(options, error)
        throw new InProcessConnectionError("checkUpgrade", { cause: error })
      }
    },
    async reload() {
      try {
        const { AppRuntime } = await import("@/effect/app-runtime")
        const { Config } = await import("@/config/config")
        const { disposeAllInstancesAndEmitGlobalDisposed } = await import("@/server/global-lifecycle")
        const { Effect } = await import("effect")
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            yield* cfg.invalidate()
            yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
          }),
        )
      } catch (error) {
        report(options, error)
        throw new InProcessConnectionError("reload", { cause: error })
      }
    },
    async shutdown() {
      try {
        events.dispose()
        if (options.disposeInstances) await options.disposeInstances()
        else {
          const { InstanceRuntime } = await import("@/project/instance-runtime")
          await InstanceRuntime.disposeAllInstances()
        }
        if (server) await server.stop(true)
      } catch (error) {
        // Shutdown is best-effort (mirrors the worker path's stop() which
        // swallows via withTimeout/catch); report non-fatally, don't throw.
        report(options, error)
      } finally {
        server = undefined
      }
    },
    async snapshot() {
      try {
        const { writeHeapSnapshot } = await import("node:v8")
        return writeHeapSnapshot("server.heapsnapshot")
      } catch (error) {
        report(options, error)
        throw new InProcessConnectionError("snapshot", { cause: error })
      }
    },
  }
}

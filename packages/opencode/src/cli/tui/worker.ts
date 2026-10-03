import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"

Heap.start()

// The TUI is the default command (`$0` in cli/cmd/tui.ts), so first-run
// install telemetry and the weekly heartbeat must fire here, not only in
// the headless `run` handler. Fire-and-forget; the module catches its own
// failures and the worker must not block startup on the network.
void import("@/installation/telemetry").then(async (m) => {
  await m.pingOnFirstRun()
  await m.heartbeat()
})

// Subscribe to global events and forward them via RPC. The handler is named
// so shutdown can unsubscribe it — otherwise the worker leaks the listener
// across server restarts in the same process.
//
// Worker-side pre-filtering (protocol v2, backward compatible):
// - `sync` duplicate envelopes are dropped here; the TUI drops them anyway.
// - Session events outside the visible set (reported by the TUI thread via
//   the `setVisibleSessions` RPC) are dropped before crossing the boundary.
//   Until the TUI reports, the filter stays inactive (pass-through).
// - Mergeable per-token deltas (text/reasoning/tool-input) are coalesced
//   per part over a ~33ms window; consumers append (`+=`) so one merged
//   delta renders identically to the fragments.
// - Anything the classifier cannot understand is passed through, never
//   dropped, so unknown future event shapes cannot stall the TUI.
const visibleSessionIDs = new Set<string>()
let hasVisibleFilter = false

const forwardEvent = (event: GlobalEvent) => {
  try {
    Rpc.emit("global.event", event)
  } catch (error) {
    console.error("[tui-worker] event forward failed", error instanceof Error ? error.message : String(error))
  }
}

const coalescer = Rpc.createCoalescer(forwardEvent)

const onGlobalEvent = (event: GlobalEvent) => {
  let forward: boolean
  try {
    forward = Rpc.shouldForward(event, hasVisibleFilter ? visibleSessionIDs : undefined)
  } catch {
    forward = true
  }
  if (!forward) return
  try {
    const key = Rpc.deltaKey(event)
    if (key !== undefined) {
      coalescer.push(key, event)
      return
    }
    // Non-delta: flush buffered deltas first so cross-boundary order is
    // preserved (e.g. deltas before their `.ended` boundary event).
    coalescer.flush()
    forwardEvent(event)
  } catch {
    // Degrade to pass-through: a coalescing failure must not drop the event
    // or break this subscriber (which would stall every TUI update).
    forwardEvent(event)
  }
}
GlobalBus.on("event", onGlobalEvent)

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    try {
      if (server) await server.stop(true)
      server = await Server.listen(input)
      return { url: server.url.toString() }
    } catch (error) {
      // Surface the failure through the RPC channel instead of letting an
      // uncaught exception abort the worker process.
      console.error("[tui-worker] server start failed", error)
      throw new Error(error instanceof Error ? error.message : String(error))
    }
  },
  async checkUpgrade(input: { directory: string }) {
    try {
      await InstanceRuntime.load({ directory: input.directory })
      await upgrade().catch(() => {})
    } catch (error) {
      console.error("[tui-worker] upgrade check failed", error)
      throw new Error(error instanceof Error ? error.message : String(error))
    }
  },
  async reload() {
    try {
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const cfg = yield* Config.Service
          yield* cfg.invalidate()
          yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
        }),
      )
    } catch (error) {
      console.error("[tui-worker] reload failed", error)
      throw new Error(error instanceof Error ? error.message : String(error))
    }
  },
  async shutdown() {
    GlobalBus.off("event", onGlobalEvent)
    coalescer.flush()
    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
  },
  // Sessions currently displayed by the TUI thread. Unknown to old TUI
  // threads (which never call this); malformed input keeps the previous
  // filter so a bad call cannot start dropping events.
  async setVisibleSessions(input: { sessionIDs: string[] }) {
    const ids = Array.isArray(input?.sessionIDs)
      ? input.sessionIDs.filter((id): id is string => typeof id === "string")
      : undefined
    if (ids === undefined) return { ok: true as const }
    visibleSessionIDs.clear()
    for (const id of ids) visibleSessionIDs.add(id)
    hasVisibleFilter = true
    // Admitted buffer was accepted under the old filter; emit it rather
    // than holding it past the filter change.
    coalescer.flush()
    return { ok: true as const }
  },
}

Rpc.listen(rpc)

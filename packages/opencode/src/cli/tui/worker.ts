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
const onGlobalEvent = (event: GlobalEvent) => {
  Rpc.emit("global.event", event)
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
    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
  },
}

Rpc.listen(rpc)

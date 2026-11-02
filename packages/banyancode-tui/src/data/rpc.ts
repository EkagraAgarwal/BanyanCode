import type { Context } from "@opencode/plugin/tui/context"
import type { RpcClient } from "@opencode/client/promise/api"
import {
  BanyanRpc,
  CodegraphRpc,
  IntelRpc,
  MeshRpc,
  SystemRpc,
  UsageRpc,
  VerifyRpc,
} from "./pending-rpc"

/**
 * Typed client layer for every BanyanCode RPC the TUI touches.
 *
 * `client.rpc(definition)` returns a proxy whose method calls reject when the
 * server has not registered that `rpcID` yet (`rpc.method_not_found` /
 * `rpc.unavailable`). Nothing here assumes the server side exists: callers get
 * a discriminated `Result` and render a "not available" state instead.
 *
 * Definitions come from `@banyancode/plugin/rpc*` (see `./pending-rpc.ts`) and
 * are re-wrapped into portable schemas in one place.
 */
export type RpcLayer = {
  readonly core: RpcClient<typeof BanyanRpc>
  readonly codegraph: RpcClient<typeof CodegraphRpc>
  readonly intel: RpcClient<typeof IntelRpc>
  readonly mesh: RpcClient<typeof MeshRpc>
  readonly usage: RpcClient<typeof UsageRpc>
  readonly system: RpcClient<typeof SystemRpc>
  readonly verify: RpcClient<typeof VerifyRpc>
}

type Location = NonNullable<Context["location"]>

/**
 * Plugin RPC is per location, and a call without one is answered by a plugin instance in the service's default
 * location, usually the home folder. That instance reads an empty database and starts indexing that folder, so every
 * call names the current location, and events from other locations are dropped.
 */
function scoped<D extends Parameters<Context["client"]["rpc"]>[0]>(
  client: RpcClient<D>,
  location: () => Location | undefined,
): RpcClient<D> {
  const events = (client as { readonly events: { readonly on: (...args: never[]) => () => void } }).events
  const scopedEvents = new Proxy(events, {
    get: (target, property) =>
      property !== "on"
        ? Reflect.get(target, property)
        : (name: never, handler: (event: { readonly location?: { readonly directory?: string } }) => unknown, options: never) =>
            target.on(
              name,
              ((event: { readonly location?: { readonly directory?: string } }) => {
                const from = event.location?.directory
                if (from !== undefined && location() !== undefined && from !== location()?.directory) return
                return handler(event)
              }) as never,
              options,
            ),
  })
  return new Proxy(client, {
    get(target, property) {
      if (property === "events") return scopedEvents
      const method = Reflect.get(target, property) as unknown
      if (typeof method !== "function") return method
      return (input: unknown, options?: object) => {
        const current = location()
        if (current === undefined) return Promise.reject({ type: "rpc.unavailable", message: "No location is ready yet" })
        return Reflect.apply(method, target, [input, { ...options, location: current }])
      }
    },
  })
}

export function createRpcLayer(client: Context["client"], location: () => Location | undefined): RpcLayer {
  return {
    core: scoped(client.rpc(BanyanRpc), location),
    codegraph: scoped(client.rpc(CodegraphRpc), location),
    intel: scoped(client.rpc(IntelRpc), location),
    mesh: scoped(client.rpc(MeshRpc), location),
    usage: scoped(client.rpc(UsageRpc), location),
    system: scoped(client.rpc(SystemRpc), location),
    verify: scoped(client.rpc(VerifyRpc), location),
  }
}

export type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly unavailable: boolean; readonly message: string }

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}

/** True when the server has no such RPC id/method, i.e. the namespace is not built yet. */
export function isUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("type" in error)) return false
  return error.type === "rpc.unavailable" || error.type === "rpc.method_not_found"
}

export async function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return { ok: false, unavailable: isUnavailable(error), message: messageOf(error) }
  }
}

export type Availability = "unknown" | "available" | "unavailable"

export function availabilityOf(result: Attempt<unknown>): Availability {
  if (result.ok) return "available"
  return result.unavailable ? "unavailable" : "available"
}

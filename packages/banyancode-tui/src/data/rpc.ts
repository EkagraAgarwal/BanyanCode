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

export function createRpcLayer(client: Context["client"]): RpcLayer {
  return {
    core: client.rpc(BanyanRpc),
    codegraph: client.rpc(CodegraphRpc),
    intel: client.rpc(IntelRpc),
    mesh: client.rpc(MeshRpc),
    usage: client.rpc(UsageRpc),
    system: client.rpc(SystemRpc),
    verify: client.rpc(VerifyRpc),
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

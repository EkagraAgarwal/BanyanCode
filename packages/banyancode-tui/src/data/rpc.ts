import type { Context } from "@opencode/plugin/tui/context"
import { Definition as CoreDefinition } from "@banyancode/plugin/rpc"
import { Rpc } from "@opencode/schema/rpc"
import { Schema } from "effect"
import { CodegraphRpc, IntelRpc, MeshRpc, SystemRpc, UsageRpc } from "./pending-rpc"

/**
 * `@banyancode/plugin/rpc` is the server-side definition, so its method
 * schemas are Effect codecs. Promise clients only accept portable schemas
 * (Standard Schema or JSON Schema), so re-wrap the same schemas instead of
 * copying them — the server stays the single source of truth for `banyancode`
 * status/config shapes.
 */
const portable = (schema: unknown) => Schema.toStandardSchemaV1(schema as Schema.Codec<unknown, unknown>)

const CoreRpc = Rpc.define({
  id: CoreDefinition.id,
  methods: {
    status: {
      input: portable(CoreDefinition.methods.status.input),
      output: portable(CoreDefinition.methods.status.output),
    },
    "config.get": {
      input: portable(CoreDefinition.methods["config.get"].input),
      output: portable(CoreDefinition.methods["config.get"].output),
    },
  },
  events: {},
})

/**
 * Typed client layer for every BanyanCode RPC the TUI touches.
 *
 * `client.rpc(definition)` returns a proxy whose method calls reject when the
 * server has not registered that `rpcID` yet (`rpc.method_not_found` /
 * `rpc.unavailable`). Nothing here assumes the server side exists: callers get
 * a discriminated `Result` and render a "not available" state instead.
 *
 * Swapping a placeholder for the real definition is a one-line import change
 * in `./pending-rpc.ts` once `packages/banyancode` exports it.
 */
export function createRpcLayer(client: Context["client"]) {
  return {
    core: client.rpc(CoreRpc),
    codegraph: client.rpc(CodegraphRpc),
    mesh: client.rpc(MeshRpc),
    usage: client.rpc(UsageRpc),
    system: client.rpc(SystemRpc),
    intel: client.rpc(IntelRpc),
  }
}

export type RpcLayer = ReturnType<typeof createRpcLayer>

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

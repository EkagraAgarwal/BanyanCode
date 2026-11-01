// Typed client surface for the `banyancode.*` RPCs the MCP code tools call.
//
// The server-side definitions live in `@banyancode/plugin/rpc/{codegraph,intel,verify}`
// and are Effect codecs. `client.rpc` only accepts portable definitions
// (Standard Schema / JSON Schema) for its *type* contract, but at runtime it
// reads nothing but `definition.id` and the method names — schemas are never
// validated on the client. So the real definitions are passed straight through
// and the caller type is rebuilt from their exact method signatures: one source
// of truth for every wire shape, no duplicated schemas, no effect copy at
// runtime. (`packages/banyancode-tui/src/data/rpc.ts` wraps the same schemas
// with `Schema.toStandardSchemaV1`; that is only needed when the definition
// object must satisfy `Rpc.PortableDefinition` literally.)

import type { Rpc } from "@opencode/schema/rpc"
import type { OpenCodeClient } from "@opencode/client"

export type RpcCallOptions = { readonly location?: { readonly directory?: string } }

/** A client for one RPC definition, typed by the server's own method schemas. */
export type RpcClientOf<D extends Rpc.Definition> = {
  readonly [K in keyof D["methods"]]: (
    input: Rpc.Input<D["methods"][K]["input"]>,
    options?: RpcCallOptions,
  ) => Promise<Rpc.Output<D["methods"][K]["output"]>>
}

/**
 * Callable RPC surface. Generic over the server definition so tools keep the
 * exact input/output types; `OpenCodeClient["rpc"]` supplies the runtime.
 */
export type RpcCaller = <D extends Rpc.Definition>(definition: D) => RpcClientOf<D>

export const createRpcCaller = (client: OpenCodeClient): RpcCaller =>
  <D extends Rpc.Definition>(definition: D) =>
    // SAFETY: `makeRpc` only reads `id` and `Object.keys(methods)`, both of
    // which the server definition has; the schemas are never invoked client-side.
    client.rpc(definition as unknown as Rpc.PortableDefinition) as unknown as RpcClientOf<D>

/** Wire payload for the failure mode where the server has no such namespace. */
export const isRpcUnavailable = (error: unknown): boolean => {
  if (error === null || typeof error !== "object" || !("type" in error)) return false
  const type = (error as { type?: unknown }).type
  return type === "rpc.unavailable" || type === "rpc.method_not_found"
}

export const messageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error !== null && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

export * as McpRpc from "./rpc"

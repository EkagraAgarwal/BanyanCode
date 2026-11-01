import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"

/**
 * Drops `undefined`-valued keys, recursively, from plain objects and arrays.
 * Class instances and other non-plain values pass through untouched.
 */
export const stripUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (value === null || typeof value !== "object") return value
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (item === undefined ? [] : [[key, stripUndefined(item)]])),
  )
}

type AnyHandler = (...args: readonly unknown[]) => unknown

/**
 * `Schema.optional` accepts an explicit `undefined`, but the RPC HTTP response
 * must be strict JSON, so `{ nextCursor: undefined }` passes the method's output
 * schema and then fails as a 500 ("failed to encode its response"). Every
 * BanyanCode handler goes through this one wrapper rather than each one having
 * to remember to omit its optional keys.
 */
export const withJsonSafeRpc = (ctx: Context): Context => {
  const register: Context["rpc"]["register"] = (definition, handlers) =>
    ctx.rpc.register(
      definition,
      Object.fromEntries(
        Object.entries(handlers as Record<string, AnyHandler>).map(([name, handler]) => [
          name,
          (...args: readonly unknown[]) => {
            const result = handler(...args)
            return Effect.isEffect(result) ? result.pipe(Effect.map(stripUndefined)) : stripUndefined(result)
          },
        ]),
      ) as typeof handlers,
    )
  // `ctx.rpc` is itself the client function, with `register` attached.
  const client = ((definition: never) => ctx.rpc(definition)) as unknown as Context["rpc"]
  return { ...ctx, rpc: Object.assign(client, ctx.rpc, { register }) }
}

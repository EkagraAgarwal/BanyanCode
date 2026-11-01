import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { stripUndefined, withJsonSafeRpc } from "../../src/integration/json-rpc.js"
import type { Context } from "@opencode/plugin/effect/plugin"

const isStrictJson = Schema.is(Schema.Json)

describe("stripUndefined", () => {
  test("turns a value strict JSON rejects into one it accepts", () => {
    const page = { nodes: [{ id: "a", signature: undefined }], nextCursor: undefined }
    expect(isStrictJson(page)).toBe(false)
    const stripped = stripUndefined(page)
    expect(isStrictJson(stripped)).toBe(true)
    expect(stripped).toEqual({ nodes: [{ id: "a" }] })
    expect(Object.keys(stripped as object)).toEqual(["nodes"])
  })

  test("keeps null, falsy values and non-plain objects", () => {
    const date = new Date(0)
    expect(stripUndefined({ a: null, b: 0, c: "", d: false, e: date })).toEqual({
      a: null,
      b: 0,
      c: "",
      d: false,
      e: date,
    })
  })
})

describe("withJsonSafeRpc", () => {
  test("wraps handlers and leaves the rest of the rpc domain working", async () => {
    let registered: Record<string, (input: unknown) => Effect.Effect<unknown>> = {}
    const host = {
      location: { directory: "/project" },
      // The real domain is callable (the typed client) with `register` attached.
      rpc: Object.assign(() => "client", {
        register: (_definition: unknown, handlers: typeof registered) => {
          registered = handlers
          return Effect.void
        },
      }),
    } as unknown as Context

    const ctx = withJsonSafeRpc(host)
    await Effect.runPromise(
      ctx.rpc.register({ id: "t", methods: {}, events: {} } as never, {
        page: () => Effect.succeed({ items: [], nextCursor: undefined }),
      } as never) as Effect.Effect<unknown>,
    )

    expect(ctx.location).toBe(host.location)
    expect((ctx.rpc as unknown as () => string)()).toBe("client")
    const output = await Effect.runPromise(registered.page!({}))
    expect(output).toEqual({ items: [] })
    expect(Object.keys(output as object)).toEqual(["items"])
  })
})

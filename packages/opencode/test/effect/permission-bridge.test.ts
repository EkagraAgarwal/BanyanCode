import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Permission } from "../../src/permission"
import { PermissionBridge } from "../../src/effect/permission-bridge"

const allowLayer = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    ask: () => Effect.void,
    reply: () => Effect.void,
    list: () => Effect.succeed([]),
  }),
)

const denyLayer = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    ask: () => Effect.fail(new PermissionV1.DeniedError({ ruleset: [] })) as Effect.Effect<void, PermissionV1.Error>,
    reply: () => Effect.void,
    list: () => Effect.succeed([]),
  }),
)

const captureAskLayer = (capture: { input?: PermissionV1.AskInput }) =>
  Layer.succeed(
    Permission.Service,
    Permission.Service.of({
      ask: (input: PermissionV1.AskInput) => {
        capture.input = input
        return Effect.void
      },
      reply: () => Effect.void,
      list: () => Effect.succeed([]),
    }),
  )

const runWith = <A, E>(
  v1: Layer.Layer<Permission.Service, never, never>,
  body: Effect.Effect<A, E, PermissionV2.Service>,
): Promise<A> =>
  Effect.runPromise(body.pipe(Effect.provide(PermissionBridge.layer), Effect.provide(v1)))

describe("PermissionBridge", () => {
  it("assert returns void when v1 allows the action", async () => {
    const result = await runWith(
      allowLayer,
      Effect.gen(function* () {
        const v2 = yield* PermissionV2.Service
        return yield* v2.assert({
          sessionID: "ses_test" as never,
          action: "tool",
          resources: ["src/foo.ts"],
          save: [],
        })
      }),
    )
    expect(result).toBeUndefined()
  })

  it("assert fails when v1 denies the action", async () => {
    const exit = await runWith(
      denyLayer,
      Effect.gen(function* () {
        const v2 = yield* PermissionV2.Service
        return yield* v2
          .assert({
            sessionID: "ses_test" as never,
            action: "tool",
            resources: ["src/foo.ts"],
            save: [],
          })
          .pipe(Effect.exit)
      }),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("metadata round-trips through to v1", async () => {
    const captured: { input?: PermissionV1.AskInput } = {}
    await runWith(
      captureAskLayer(captured),
      Effect.gen(function* () {
        const v2 = yield* PermissionV2.Service
        yield* v2.assert({
          sessionID: "ses_test" as never,
          action: "tool",
          resources: ["src/foo.ts"],
          save: [],
          metadata: { foo: "bar", count: 42 },
        })
      }),
    )
    expect(captured.input?.metadata).toEqual({ foo: "bar", count: 42 })
    expect(captured.input?.permission).toBe("tool")
    expect(captured.input?.patterns).toEqual(["src/foo.ts"])
  })
})

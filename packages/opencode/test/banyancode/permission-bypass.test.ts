import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Permission } from "../../src/permission"
import { PermissionBridge } from "../../src/effect/permission-bridge"

const captureAskLayer = (calls: { input?: PermissionV1.AskInput }[]) =>
  Layer.succeed(
    Permission.Service,
    Permission.Service.of({
      ask: (input: PermissionV1.AskInput) => {
        calls.push({ input })
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

describe("PermissionBridge bypass for code_find and websearch_free", () => {
  it("assert short-circuits for code_find without calling v1.ask", async () => {
    const calls: { input?: PermissionV1.AskInput }[] = []
    await runWith(
      captureAskLayer(calls),
      Effect.gen(function* () {
        const v2 = yield* PermissionV2.Service
        yield* v2.assert({
          sessionID: "ses_test" as never,
          action: "code_find",
          resources: ["X"],
          save: ["*"],
        })
      }),
    )
    expect(calls.length).toBe(0)
  })

  it("assert short-circuits for websearch_free without calling v1.ask", async () => {
    const calls: { input?: PermissionV1.AskInput }[] = []
    await runWith(
      captureAskLayer(calls),
      Effect.gen(function* () {
        const v2 = yield* PermissionV2.Service
        yield* v2.assert({
          sessionID: "ses_test" as never,
          action: "websearch_free",
          resources: ["query"],
          save: ["*"],
        })
      }),
    )
    expect(calls.length).toBe(0)
  })

  it("assert still calls v1.ask for unlisted actions like bash", async () => {
    const calls: { input?: PermissionV1.AskInput }[] = []
    await runWith(
      captureAskLayer(calls),
      Effect.gen(function* () {
        const v2 = yield* PermissionV2.Service
        yield* v2.assert({
          sessionID: "ses_test" as never,
          action: "bash",
          resources: ["ls"],
          save: ["*"],
        })
      }),
    )
    expect(calls.length).toBe(1)
    expect(calls[0].input?.permission).toBe("bash")
  })

  it("ask returns allow directly for code_find without calling v1.ask", async () => {
    const calls: { input?: PermissionV1.AskInput }[] = []
    await runWith(
      captureAskLayer(calls),
      Effect.gen(function* () {
        const v2 = yield* PermissionV2.Service
        const result = yield* v2.ask({
          sessionID: "ses_test" as never,
          action: "code_find",
          resources: ["X"],
          save: ["*"],
        })
        expect(result.effect).toBe("allow")
      }),
    )
    expect(calls.length).toBe(0)
  })

  it("ask returns allow directly for websearch_free without calling v1.ask", async () => {
    const calls: { input?: PermissionV1.AskInput }[] = []
    await runWith(
      captureAskLayer(calls),
      Effect.gen(function* () {
        const v2 = yield* PermissionV2.Service
        const result = yield* v2.ask({
          sessionID: "ses_test" as never,
          action: "websearch_free",
          resources: ["query"],
          save: ["*"],
        })
        expect(result.effect).toBe("allow")
      }),
    )
    expect(calls.length).toBe(0)
  })

  it("toAskInput preserves '*' in always when save contains '*'", async () => {
    const calls: { input?: PermissionV1.AskInput }[] = []
    await runWith(
      captureAskLayer(calls),
      Effect.gen(function* () {
        const v2 = yield* PermissionV2.Service
        yield* v2.assert({
          sessionID: "ses_test" as never,
          action: "bash",
          resources: ["ls"],
          save: ["*"],
        })
      }),
    )
    expect(calls.length).toBe(1)
    expect(calls[0].input?.always).toEqual(["*"])
  })
})

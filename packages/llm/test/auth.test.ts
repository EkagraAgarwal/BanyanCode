import { describe, expect } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import { Headers } from "effect/unstable/http"
import { LLM } from "../src"
import { Auth } from "../src/route/auth"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { Model } from "../src/schema"
import { it } from "./lib/effect"

const request = LLM.request({
  id: "req_auth",
  model: Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route }),
  prompt: "hello",
})

const input = {
  request,
  method: "POST" as const,
  url: "https://example.test/v1/chat",
  body: "{}",
  headers: Headers.fromInput({ "x-existing": "yes" }),
}

const withEnv = (env: Record<string, string>) => Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))

describe("Auth", () => {
  it.effect("renders a config credential as bearer auth", () =>
    Effect.gen(function* () {
      const headers = yield* Auth.config("OPENAI_API_KEY")
        .bearer()
        .apply(input)
        .pipe(withEnv({ OPENAI_API_KEY: "<configured-credential>" }))

      expect(headers.authorization).toBe("Bearer <configured-credential>")
      expect(headers["x-existing"]).toBe("yes")
    }),
  )

  it.effect("falls back between credential sources before rendering", () =>
    Effect.gen(function* () {
      const headers = yield* Auth.config("PRIMARY_KEY")
        .orElse(Auth.value("<fallback-credential>"))
        .pipe(Auth.header("x-api-key"))
        .apply(input)
        .pipe(withEnv({}))

      expect(headers["x-api-key"]).toBe("<fallback-credential>")
      expect(headers["x-existing"]).toBe("yes")
    }),
  )

  it.effect("composes header auth in sequence", () =>
    Effect.gen(function* () {
      const headers = yield* Auth.headers({ "x-tenant-id": "tenant-1" })
        .andThen(Auth.bearer("<gateway-credential>"))
        .apply(input)

      expect(headers["x-tenant-id"]).toBe("tenant-1")
      expect(headers.authorization).toBe("Bearer <gateway-credential>")
      expect(headers["x-existing"]).toBe("yes")
    }),
  )

  it.effect("renders a direct secret as a custom header", () =>
    Effect.gen(function* () {
      const headers = yield* Auth.header("api-key", "<direct-credential>").apply(input)

      expect(headers["api-key"]).toBe("<direct-credential>")
      expect(headers["x-existing"]).toBe("yes")
    }),
  )

  it.effect("renders bearer auth into a custom header", () =>
    Effect.gen(function* () {
      const headers = yield* Auth.bearerHeader("cf-aig-authorization", "<gateway-credential>").apply(input)

      expect(headers["cf-aig-authorization"]).toBe("Bearer <gateway-credential>")
      expect(headers["x-existing"]).toBe("yes")
    }),
  )

  it.effect("falls back between full auth values", () =>
    Effect.gen(function* () {
      const headers = yield* Auth.config("OPENAI_API_KEY")
        .bearer()
        .orElse(Auth.headers({ authorization: "Bearer <supplied-credential>" }))
        .apply(input)
        .pipe(withEnv({}))

      expect(headers.authorization).toBe("Bearer <supplied-credential>")
      expect(headers["x-existing"]).toBe("yes")
    }),
  )

  it.effect("can intentionally leave auth untouched", () =>
    Effect.gen(function* () {
      const headers = yield* Auth.none.apply(input)

      expect(headers.authorization).toBeUndefined()
      expect(headers["x-existing"]).toBe("yes")
    }),
  )
})

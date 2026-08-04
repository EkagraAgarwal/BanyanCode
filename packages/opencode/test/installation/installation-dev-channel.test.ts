import { describe, expect, mock } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import { testEffect } from "../lib/effect"

// Force the dev channel so the channel-aware npm branch of
// Installation.latest runs (the version module's exports are build-time
// constants, normally "local" in tests).
mock.module("@opencode-ai/core/installation/version", () => ({
  InstallationChannel: "dev",
  InstallationVersion: "26.8.11-dev.abc1234",
  InstallationLocal: false,
}))

import { Installation } from "../../src/installation"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner() {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const appProcess = AppProcess.layer.pipe(Layer.provide(mockSpawner()))
  return Installation.layer.pipe(Layer.provide(mockHttpClient(handler)), Layer.provide(appProcess))
}

describe("installation latest (dev channel)", () => {
  testEffect(
    testLayer((request) => {
      if (request.url.endsWith("/banyancode/dev")) return jsonResponse({ version: "26.8.12-dev.abc1234" })
      if (request.url.endsWith("/banyancode/latest")) return jsonResponse({ version: "26.8.11" })
      return jsonResponse({})
    }),
  ).live("fetches both dist-tags and prefers the canary when its core is newer", () =>
    Effect.gen(function* () {
      const result = yield* Installation.use.latest("npm")
      expect(result).toBe("26.8.12-dev.abc1234")
    }),
  )

  testEffect(
    testLayer((request) => {
      if (request.url.endsWith("/banyancode/dev")) return jsonResponse({ version: "26.8.11-dev.abc1234" })
      if (request.url.endsWith("/banyancode/latest")) return jsonResponse({ version: "26.8.12" })
      return jsonResponse({})
    }),
  ).live("returns the stable tag when its core is strictly greater", () =>
    Effect.gen(function* () {
      const result = yield* Installation.use.latest("npm")
      expect(result).toBe("26.8.12")
    }),
  )

  testEffect(
    testLayer((request) => {
      if (request.url.endsWith("/banyancode/dev")) {
        return new Response("nope", { status: 500 })
      }
      if (request.url.endsWith("/banyancode/latest")) return jsonResponse({ version: "26.8.11" })
      return jsonResponse({})
    }),
  ).live("falls back to the stable tag when the dev fetch fails", () =>
    Effect.gen(function* () {
      const result = yield* Installation.use.latest("npm")
      expect(result).toBe("26.8.11")
    }),
  )
})

// R5/Q1: Server.listen must build on the process-shared memoMap instead of a
// fresh one per listener, so the listener reuses AppRuntime's Database,
// EventV2, InstanceStore and tool services — and so events published via a
// shared-map service are observable on the listener's SSE streams.
import { afterEach, describe, expect, test } from "bun:test"
import net from "node:net"
import { Context, Effect, Exit, Layer, Schema, Scope } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Server } from "../../src/server/server"
import { withTimeout } from "../../src/util/timeout"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

const saved = {
  password: Flag.OPENCODE_SERVER_PASSWORD,
  username: Flag.OPENCODE_SERVER_USERNAME,
  envPassword: process.env.OPENCODE_SERVER_PASSWORD,
  envUsername: process.env.OPENCODE_SERVER_USERNAME,
}

afterEach(async () => {
  Flag.OPENCODE_SERVER_PASSWORD = saved.password
  Flag.OPENCODE_SERVER_USERNAME = saved.username
  if (saved.envPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = saved.envPassword
  if (saved.envUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME
  else process.env.OPENCODE_SERVER_USERNAME = saved.envUsername
  await disposeAllInstances()
  await resetDatabase()
})

async function startNoAuthListener() {
  Flag.OPENCODE_SERVER_PASSWORD = undefined
  Flag.OPENCODE_SERVER_USERNAME = "opencode"
  delete process.env.OPENCODE_SERVER_PASSWORD
  process.env.OPENCODE_SERVER_USERNAME = "opencode"
  return Server.listen({ hostname: "127.0.0.1", port: 0 })
}

// Non-durable on purpose: no `sync` section means publish is pure in-memory
// fan-out with no database commit, so the test proves bus identity without
// touching any store.
const MemoPing = {
  type: "test.memo.ping",
  data: Schema.Struct({ nonce: Schema.String }),
} as const

type GlobalFrame = { payload?: { id?: string; type?: string; properties?: unknown } }

function parseFrame(block: string): GlobalFrame | undefined {
  const line = block.split("\n").find((l) => l.startsWith("data:"))
  if (!line) return undefined
  try {
    return JSON.parse(line.slice("data:".length).trim()) as GlobalFrame
  } catch {
    return undefined
  }
}

async function openGlobalStream(url: URL) {
  const controller = new AbortController()
  const response = await fetch(new URL("/global/event", url), { signal: controller.signal })
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const next = (predicate: (frame: GlobalFrame) => boolean, message: string): Promise<void> => {
    const wait = (async () => {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error("event stream closed before matching frame")
        buffer += decoder.decode(chunk.value, { stream: true })
        const blocks = buffer.split("\n\n")
        buffer = blocks.pop() ?? ""
        for (const block of blocks) {
          const frame = parseFrame(block)
          if (frame && predicate(frame)) return
        }
      }
    })()
    return withTimeout(wait, 10_000, message)
  }
  const close = () => {
    controller.abort()
    reader.cancel().catch(() => undefined)
  }
  return { next, close }
}

async function tryOccupy4096(): Promise<net.Server | undefined> {
  const squatter = net.createServer()
  const free = await new Promise<boolean>((resolve) => {
    squatter.once("error", () => resolve(false))
    squatter.listen(4096, "127.0.0.1", () => resolve(true))
  })
  if (!free) return undefined
  return squatter
}

describe("Server.listen shared memoMap", () => {
  test(
    "publishes from a shared-memoMap EventV2 onto the listener SSE stream",
    async () => {
      const listener = await startNoAuthListener()
      const scope = Scope.makeUnsafe()
      try {
        // One stream for both waits: server.connected proves this
        // connection's bus handler is registered, so the later publish
        // cannot land before the subscription exists.
        const stream = await openGlobalStream(listener.url)
        try {
          await stream.next(
            (frame: GlobalFrame) => frame.payload?.type === "server.connected",
            "timed out waiting for server.connected on listener SSE",
          )

          // Build EventV2 against the SAME shared memoMap the listener used.
          // With a fresh map per listener (the old bug) this is a second,
          // disconnected bus and the ping never reaches the stream.
          const context = await Effect.runPromise(Layer.buildWithMemoMap(EventV2.defaultLayer, memoMap, scope))
          const events = Context.get(context, EventV2.Service)
          const nonce = `ping-${Date.now()}`
          const seen = stream.next(
            (frame: GlobalFrame) =>
              frame.payload?.type === MemoPing.type &&
              (frame.payload?.properties as { nonce?: string } | undefined)?.nonce === nonce,
            "timed out waiting for shared-bus event on listener SSE",
          )
          await Effect.runPromise(events.publish(MemoPing, { nonce }))
          await seen
        } finally {
          stream.close()
        }
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined)
        await listener.stop(true)
      }
    },
    30_000,
  )

  test(
    "restarted listener serves SSE after stop(true)",
    async () => {
      const first = await startNoAuthListener()
      await first.stop(true)
      const second = await startNoAuthListener()
      try {
        const stream = await openGlobalStream(second.url)
        try {
          await stream.next(
            (frame: GlobalFrame) => frame.payload?.type === "server.connected",
            "timed out waiting for server.connected on restarted listener SSE",
          )
        } finally {
          stream.close()
        }
      } finally {
        await second.stop(true)
      }
    },
    30_000,
  )

  test(
    "port 0 skips 4096 when it is held instead of failing the bind",
    async () => {
      const squatter = await tryOccupy4096()
      if (!squatter) return
      try {
        const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
        try {
          expect(listener.port).toBeGreaterThan(0)
          expect(listener.port).not.toBe(4096)
        } finally {
          await listener.stop(true)
        }
      } finally {
        await new Promise<void>((resolve) => squatter.close(() => resolve()))
      }
    },
    30_000,
  )
})

// Production SessionClient (mcp-server/session-client.ts) against a real
// in-process server. No SDK mocks anywhere: every call goes over HTTP to
// Server.listen booted by createMcpServer, the same shape as
// server-bootstrap.test.ts.
//
// Part A needs no provider (create/status/messages/todo/diff/pending/
// subagents/cost/abort plus error paths). Part B runs a full promptAsync
// round trip through TestLLMServer with model "test/test-model", which also
// exercises the provider/model split.

import { afterEach, describe, expect, test } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { createMcpServer } from "../../src/mcp-server/server"
import { createSdkSessionClient, splitModelRef } from "../../src/mcp-server/session-client"
import { disposeAllInstances, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const savedCwd = process.cwd()
const savedPassword = process.env.OPENCODE_SERVER_PASSWORD

afterEach(async () => {
  process.chdir(savedCwd)
  if (savedPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = savedPassword
  await disposeAllInstances()
  await resetDatabase()
})

describe("splitModelRef", () => {
  test("splits provider from model, keeping nested slashes in the model", () => {
    expect(splitModelRef("test/test-model")).toEqual({ providerID: "test", modelID: "test-model" })
    expect(splitModelRef("a/b/c")).toEqual({ providerID: "a", modelID: "b/c" })
  })

  test("returns undefined without a slash so the caller falls back to the server default", () => {
    expect(splitModelRef("noslash")).toBeUndefined()
    expect(splitModelRef("")).toBeUndefined()
  })
})

describe("createSdkSessionClient factory", () => {
  test("refuses to build without sdk or baseUrl", async () => {
    await expect(createSdkSessionClient({ directory: "/tmp" })).rejects.toThrow(/sdk or baseUrl/)
  })
})

describe("sdk session client over a real server", () => {
  test(
    "covers the full read surface plus child aggregation and error paths",
    async () => {
      const target = await tmpdir({ git: true })
      try {
        const boot = await createMcpServer({ cwd: target.path })
        try {
          const client = await createSdkSessionClient({ sdk: boot.sdk, directory: target.path })

          const created = await client.createSession({
            title: "mcp task",
            metadata: { origin: "mcp", mcp_client: "session-client-test" },
          })
          expect(typeof created.id).toBe("string")

          // Metadata passes through: the session shows up as MCP-owned.
          const fetched = await boot.sdk.session.get(
            { sessionID: created.id, directory: target.path },
            { throwOnError: true },
          )
          expect(fetched.data?.title).toBe("mcp task")
          expect(fetched.data?.metadata).toMatchObject({ origin: "mcp", mcp_client: "session-client-test" })

          expect(await client.sessionStatus({ sessionID: created.id })).toBe("idle")
          expect(await client.messages({ sessionID: created.id })).toEqual([])
          expect(await client.todo({ sessionID: created.id })).toEqual([])
          expect(await client.diff({ sessionID: created.id })).toEqual([])
          expect(await client.pending({ sessionID: created.id })).toEqual([])
          expect(await client.subagents({ sessionID: created.id })).toEqual([])
          expect(await client.cost({ sessionID: created.id })).toEqual({ cost: 0, tokensByModel: {} })

          // A forked child joins the tree: subagents/cost/pending aggregate it.
          const child = await boot.sdk.session.create(
            { directory: target.path, parentID: created.id, title: "child", agent: "build" },
            { throwOnError: true },
          )
          const childID = child.data?.id
          expect(typeof childID).toBe("string")
          const subs = await client.subagents({ sessionID: created.id })
          expect(subs.length).toBe(1)
          expect(subs[0]?.status).toBe("idle")
          expect(typeof subs[0]?.agent).toBe("string")
          expect(await client.pending({ sessionID: created.id })).toEqual([])

          await client.abort({ sessionID: childID! })

          // Error paths hit the real server: unknown sessions and requests fail.
          await expect(client.sessionStatus({ sessionID: "ses_missing" })).rejects.toThrow(/unknown session/)
          await expect(
            client.replyPermission({ sessionID: created.id, requestID: "req_missing", reply: "reject" }),
          ).rejects.toThrow(/permission\.reply failed/)
          await expect(
            client.rejectQuestion({ sessionID: created.id, requestID: "req_missing" }),
          ).rejects.toThrow(/question\.reject failed/)
          await expect(
            client.replyQuestion({ sessionID: created.id, requestID: "req_missing", message: "yes" }),
          ).rejects.toThrow(/question\.reply failed/)
        } finally {
          await boot.cleanup()
        }
      } finally {
        await target[Symbol.asyncDispose]()
      }
    },
    120_000,
  )
})

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, CrossSpawnSpawner.defaultLayer))

describe("sdk session client prompt round trip", () => {
  it.live(
    "promptAsync runs to idle, messages carry the assistant text, cost aggregates tokens",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.text("done-ok", { usage: { input: 3, output: 7 } })
        const dir = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const boot = yield* Effect.promise(() => createMcpServer({ cwd: dir }))
        try {
          const client = yield* Effect.promise(() => createSdkSessionClient({ sdk: boot.sdk, directory: dir }))
          const created = yield* Effect.promise(() =>
            client.createSession({ title: "prompt trip", metadata: { origin: "mcp" } }),
          )
          yield* Effect.promise(() =>
            client.promptAsync({
              sessionID: created.id,
              prompt: "say hi",
              agent: "build",
              model: "test/test-model",
            }),
          )

          // promptAsync returns before the processor flips the session to
          // busy, so a bare wait-for-idle can observe the pre-run idle and
          // exit early. Settle requires idle PLUS an assistant reply.
          const deadline = Date.now() + 60_000
          let settled = false
          while (!settled) {
            if (Date.now() > deadline) throw new Error("session never settled with an assistant reply")
            const status = yield* Effect.promise(() => client.sessionStatus({ sessionID: created.id }))
            const probe = yield* Effect.promise(() => client.messages({ sessionID: created.id }))
            settled = status === "idle" && probe.some((message) => message.role === "assistant" && message.text.length > 0)
            if (!settled) yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 500)))
          }
          expect(settled).toBe(true)

          const messages = yield* Effect.promise(() => client.messages({ sessionID: created.id }))
          const assistant = messages.filter((message) => message.role === "assistant")
          expect(assistant.length).toBeGreaterThan(0)
          expect(assistant.map((message) => message.text).join("\n")).toContain("done-ok")

          const cost = yield* Effect.promise(() => client.cost({ sessionID: created.id }))
          expect(cost.tokensByModel["test/test-model"]).toEqual({ input: 3, output: 7 })
          const pending = yield* Effect.promise(() => client.pending({ sessionID: created.id }))
          expect(pending).toEqual([])
        } finally {
          yield* Effect.promise(() => boot.cleanup())
        }
      }),
    180_000,
  )
})

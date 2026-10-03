// Engine live-event tests (W1.1, plan spec §2.3): the TaskEngine wired by
// createMcpServer against the REAL in-process server — real SSE event
// stream (sdk.event.subscribe), real sessions, real TestLLMServer
// provider. No mocks of the event stream anywhere.
//
// "Without polling" means: after start() returns, the test never calls
// engine.status() (the refresh path) on the handle under test.
// engine.get() is a synchronous record-table snapshot (no I/O) and
// engine.waitForStateChange() resolves from the engine's event-driven
// patch funnel — both are observation, not polling.

import { afterEach, describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { createMcpServer } from "../../src/mcp-server/server"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
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

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, CrossSpawnSpawner.defaultLayer))

function findToolPart(rows: unknown, tool: string): { state?: { status?: unknown } } | undefined {
  if (!Array.isArray(rows)) return undefined
  for (const row of rows) {
    const parts = (row as { parts?: unknown }).parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      const candidate = part as { type?: unknown; tool?: unknown }
      if (candidate.type === "tool" && candidate.tool === tool) {
        return part as { state?: { status?: unknown } }
      }
    }
  }
  return undefined
}

describe("task engine live events over a real server", () => {
  it.live(
    "queued task auto-starts after the running task finishes, without polling either handle",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.text("first-done")
        yield* llm.text("second-done")
        const dir = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const boot = yield* Effect.promise(() => createMcpServer({ cwd: dir, maxConcurrentTasks: 1 }))
        const engine = boot.engine
        expect(engine).toBeDefined()
        try {
          const first = yield* Effect.promise(() =>
            engine!.start({
              prompt: "say first",
              agent: "build",
              model: "test/test-model",
              mcpClient: "events-test",
            }),
          )
          const second = yield* Effect.promise(() =>
            engine!.start({
              prompt: "say second",
              agent: "build",
              model: "test/test-model",
              mcpClient: "events-test",
            }),
          )
          expect(first.status).toBe("running")
          expect(second.status).toBe("queued")
          // The sweep is armed while tasks are non-terminal.
          expect(engine!.sweepActive).toBe(true)

          // Event-driven waits only: the session.idle SSE for the first
          // task drives refresh → done → dequeueNext, which launches the
          // queued task. No status() call on either handle.
          const launched = yield* Effect.promise(() =>
            engine!.waitForStateChange(second.handle, { fromStatus: "queued", timeoutMs: 90_000 }),
          )
          expect(launched.status).not.toBe("queued")
          const finished = yield* Effect.promise(() =>
            engine!.waitForStateChange(second.handle, {
              fromStatus: launched.status,
              timeoutMs: 90_000,
            }),
          )
          expect(finished.status).toBe("done")
          // Sync snapshots only: the running task completed via events too.
          expect(engine!.get(first.handle).status).toBe("done")
          // Nothing non-terminal remains, so the sweep stopped itself.
          expect(engine!.sweepActive).toBe(false)
        } finally {
          yield* Effect.promise(() => boot.cleanup())
        }
      }),
    180_000,
  )

  it.live(
    "reject-policy permission ask auto-rejected without any poll",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        // A rejected tool call ends the turn: the processor records the
        // rejection and goes idle (no follow-up LLM call), so only one
        // scripted reply is needed.
        yield* llm.tool("bash", { command: "echo hello", description: "say hi" })
        // User config forces bash to ask: without the ask rule the agent
        // `"*": "allow"` default (plus the scanner finding no dangerous
        // pattern in a benign command) would allow it and no ask would
        // ever appear.
        const dir = yield* tmpdirScoped({
          git: true,
          config: { ...testProviderConfig(llm.url), permission: { bash: "ask" } },
        })
        const boot = yield* Effect.promise(() => createMcpServer({ cwd: dir }))
        const engine = boot.engine
        expect(engine).toBeDefined()
        try {
          const started = yield* Effect.promise(() =>
            engine!.start({
              prompt: "run a shell command",
              agent: "build",
              model: "test/test-model",
              permission: "reject",
              mcpClient: "events-test",
            }),
          )
          // Event-driven wait only: if the ask blocked the session (no
          // auto-reject), the task never reaches done and this times out.
          // No engine.status() call anywhere in this test.
          const done = yield* Effect.promise(() =>
            engine!.waitForStateChange(started.handle, { fromStatus: "running", timeoutMs: 120_000 }),
          )
          expect(done.status).toBe("done")
          expect(done.pendingQuestion).toBeUndefined()
          // SDK messages (not engine polling): the bash call was REJECTED
          // — not allowed — which is only possible if the permission.asked
          // event arrived over SSE and the engine replied reject.
          const raw = yield* Effect.promise(() =>
            boot.sdk.session.messages({ sessionID: started.sessionID, directory: dir }),
          )
          const rows = "data" in raw && Array.isArray(raw.data) ? raw.data : []
          const bash = findToolPart(rows, "bash")
          expect(bash !== undefined).toBe(true)
          expect(bash?.state?.status).toBe("error")
          expect(JSON.stringify(bash)).toContain("rejected")
        } finally {
          yield* Effect.promise(() => boot.cleanup())
        }
      }),
    180_000,
  )

  it.live(
    "needs_input timeout fires without a poll",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.tool("question", {
          questions: [
            {
              question: "Which file?",
              header: "File?",
              options: [{ label: "A", description: "Option A" }],
            },
          ],
        })
        yield* llm.text("continuing")
        const dir = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const boot = yield* Effect.promise(() => createMcpServer({ cwd: dir, needsInputTimeoutMs: 2_000 }))
        const engine = boot.engine
        expect(engine).toBeDefined()
        try {
          const started = yield* Effect.promise(() =>
            engine!.start({
              prompt: "ask me a question",
              agent: "build",
              model: "test/test-model",
              mcpClient: "events-test",
            }),
          )
          // The question.asked SSE flips the record without any poll.
          const asked = yield* Effect.promise(() =>
            engine!.waitForStateChange(started.handle, { fromStatus: "running", timeoutMs: 90_000 }),
          )
          expect(asked.status).toBe("needs_input")
          expect(asked.pendingQuestion?.kind).toBe("question")
          // The server-side timer started on question.asked fires on its
          // own and rejects: no status() call between the two waits.
          const after = yield* Effect.promise(() =>
            engine!.waitForStateChange(started.handle, { fromStatus: "needs_input", timeoutMs: 60_000 }),
          )
          expect(after.status).toBe("running")
          expect(after.pendingQuestion).toBeUndefined()
          // The auto-reject drained the SDK question list.
          const listed = (yield* Effect.promise(() =>
            boot.sdk.question.list({ directory: dir }, { throwOnError: true }),
          )) as { data?: unknown[] }
          expect(listed.data ?? []).toEqual([])
        } finally {
          yield* Effect.promise(() => boot.cleanup())
        }
      }),
    180_000,
  )
})

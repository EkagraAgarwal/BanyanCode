import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Banyan } from "@opencode-ai/core/banyancode"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import type { SubagentMessage } from "@opencode-ai/core/banyancode/types"

describe("SubagentMessagesRepo", () => {
  test("100 messages from 4 concurrent writers, reader sees all 100", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "subagent.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const serviceLayer = Banyan.subagentMessagesRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.SubagentMessagesRepo
        const parentSessionID = "parent-session-1"

        const writers = [
          Effect.forEach(
            Array.from({ length: 25 }, (_, i) => ({
              id: `writer-1-msg-${i}`,
              parentSessionID,
              fromSession: "session-1",
              fromAgent: "agent-1",
              toSession: "session-2",
              toAgent: "agent-2",
              kind: "request" as const,
              payload: { index: i },
              createdAt: Date.now(),
            })),
            (msg) => repo.put(msg),
            { concurrency: "unbounded" },
          ),
          Effect.forEach(
            Array.from({ length: 25 }, (_, i) => ({
              id: `writer-2-msg-${i}`,
              parentSessionID,
              fromSession: "session-2",
              fromAgent: "agent-2",
              toSession: "session-3",
              toAgent: "agent-3",
              kind: "inform" as const,
              payload: { index: i },
              createdAt: Date.now(),
            })),
            (msg) => repo.put(msg),
            { concurrency: "unbounded" },
          ),
          Effect.forEach(
            Array.from({ length: 25 }, (_, i) => ({
              id: `writer-3-msg-${i}`,
              parentSessionID,
              fromSession: "session-3",
              fromAgent: "agent-3",
              toSession: "session-4",
              toAgent: "agent-4",
              kind: "answer" as const,
              payload: { index: i },
              createdAt: Date.now(),
            })),
            (msg) => repo.put(msg),
            { concurrency: "unbounded" },
          ),
          Effect.forEach(
            Array.from({ length: 25 }, (_, i) => ({
              id: `writer-4-msg-${i}`,
              parentSessionID,
              fromSession: "session-4",
              fromAgent: "agent-4",
              toSession: "session-1",
              toAgent: "agent-1",
              kind: "poll" as const,
              payload: { index: i },
              createdAt: Date.now(),
            })),
            (msg) => repo.put(msg),
            { concurrency: "unbounded" },
          ),
        ]

        yield* Effect.all(writers, { concurrency: "unbounded" })

        const pending = yield* repo.listPending(parentSessionID)
        expect(pending.length).toBe(100)

        const firstMsg = pending.find((m: SubagentMessage) => m.id === "writer-1-msg-0")
        expect(firstMsg).toBeDefined()
        expect(firstMsg?.kind).toBe("request")
        expect(firstMsg?.payload).toEqual({ index: 0 })

        const allIDs = pending.map((m: SubagentMessage) => m.id).sort()
        expect(allIDs.length).toBe(100)
        for (let i = 0; i < 4; i++) {
          for (let j = 0; j < 25; j++) {
            expect(allIDs).toContain(`writer-${i + 1}-msg-${j}`)
          }
        }
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("markDelivered marks messages and listByParent filters correctly", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "delivered.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const serviceLayer = Banyan.subagentMessagesRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.SubagentMessagesRepo
        const parentSessionID = "parent-session-2"

        for (let i = 0; i < 10; i++) {
          yield* repo.put({
            id: `msg-${i}`,
            parentSessionID,
            fromSession: "session-1",
            fromAgent: "agent-1",
            kind: "request",
            payload: { i },
            createdAt: Date.now(),
          })
        }

        const pending = yield* repo.listPending(parentSessionID)
        expect(pending.length).toBe(10)

        yield* repo.markDelivered("msg-0", Date.now())
        yield* repo.markDelivered("msg-1", Date.now())
        yield* repo.markDelivered("msg-2", Date.now())

        const stillPending = yield* repo.listPending(parentSessionID)
        expect(stillPending.length).toBe(7)

        const deliveredMessages = yield* repo.listByParent(parentSessionID, true)
        expect(deliveredMessages.length).toBe(3)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { listGatewayUsage, listToolUsage, recordGatewayUsage, recordToolUsage } from "../../src/telemetry/usage.js"
import { withStorage, withTemp } from "../gateway/harness.js"

describe("tool usage tables", () => {
  test("lifetime rows aggregate, per-session rows attribute every session", async () => {
    await withTemp(async (directory) => {
      const result = await withStorage(directory, (storage) =>
        Effect.gen(function* () {
          yield* recordToolUsage(storage, "read", "ses_a")
          yield* recordToolUsage(storage, "read", "ses_a")
          yield* recordToolUsage(storage, "grep", "ses_b")
          yield* recordToolUsage(storage, "read", "ses_b")
          return {
            all: yield* listToolUsage(storage),
            sessionA: yield* listToolUsage(storage, { session: "ses_a" }),
            sessionB: yield* listToolUsage(storage, { session: "ses_b" }),
          }
        }),
      ).pipe(Effect.runPromise)

      expect(result.all.tools).toEqual([
        expect.objectContaining({ toolId: "read", useCount: 3 }),
        expect.objectContaining({ toolId: "grep", useCount: 1 }),
      ])
      expect(result.sessionA.tools).toEqual([expect.objectContaining({ toolId: "read", useCount: 2 })])
      // The second session keeps its own row instead of losing the tool to the first.
      expect(result.sessionB.tools.map((row) => row.toolId).sort()).toEqual(["grep", "read"])
      expect(result.sessionB.tools.find((row) => row.toolId === "read")?.useCount).toBe(1)
    })
  })

  test("listToolUsage returns an empty result when the table is empty", async () => {
    await withTemp(async (directory) => {
      const result = await withStorage(directory, (storage) => listToolUsage(storage)).pipe(Effect.runPromise)
      expect(result).toEqual({ tools: [] })
    })
  })
})

describe("gateway usage", () => {
  test("counts routes per session and accumulates saved bytes", async () => {
    await withTemp(async (directory) => {
      const result = await withStorage(directory, (storage) =>
        Effect.gen(function* () {
          yield* recordGatewayUsage(storage, { sessionID: "ses_a", from: "grep", to: "code_find", route: "swapped" })
          yield* recordGatewayUsage(storage, { sessionID: "ses_a", from: "grep", to: "code_find", route: "swapped" })
          yield* recordGatewayUsage(storage, { sessionID: "ses_a", from: "read", to: "repo", route: "swapped", bytesSaved: 3_200 })
          yield* recordGatewayUsage(storage, { sessionID: "ses_a", from: "grep", route: "fallback" })
          yield* recordGatewayUsage(storage, { sessionID: "ses_a", from: "grep", route: "direct" })
          yield* recordGatewayUsage(storage, { sessionID: "ses_b", from: "glob", to: "repo", route: "swapped" })
          return {
            sessionA: yield* listGatewayUsage(storage, { session: "ses_a" }),
            sessionB: yield* listGatewayUsage(storage, { session: "ses_b" }),
            all: yield* listGatewayUsage(storage),
          }
        }),
      ).pipe(Effect.runPromise)

      expect(result.sessionA.summary).toEqual({ swapped: 3, fallback: 1, augmented: 0, direct: 1, bytesSaved: 3_200 })
      expect(result.sessionA.rows.find((row) => row.fromTool === "grep" && row.toTool === "code_find")).toMatchObject({
        route: "swapped",
        useCount: 2,
      })
      expect(result.sessionB.rows).toHaveLength(1)
      expect(result.all.rows).toHaveLength(5)
    })
  })

  test("an empty table is a zero summary", async () => {
    await withTemp(async (directory) => {
      const result = await withStorage(directory, (storage) => listGatewayUsage(storage, { session: "ses_none" })).pipe(
        Effect.runPromise,
      )
      expect(result).toEqual({
        rows: [],
        summary: { swapped: 0, fallback: 0, augmented: 0, direct: 0, bytesSaved: 0 },
      })
    })
  })
})

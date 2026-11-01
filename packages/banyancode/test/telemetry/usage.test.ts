import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { listToolUsage, recordToolUsage } from "../../src/telemetry/usage.js"
import { withStorage, withTemp } from "../gateway/harness.js"

describe("tool usage table port", () => {
  test("records lifetime counts and last-used timestamps", async () => {
    await withTemp(async (directory) => {
      const result = await withStorage(directory, (storage) =>
        Effect.gen(function* () {
          yield* recordToolUsage(storage, "read", "ses_a")
          yield* recordToolUsage(storage, "read", "ses_a")
          yield* recordToolUsage(storage, "grep", "ses_b")
          return {
            all: yield* listToolUsage(storage),
            sessionA: yield* listToolUsage(storage, { session: "ses_a" }),
          }
        }),
      ).pipe(Effect.runPromise)

      expect(result.all.tools).toEqual([
        expect.objectContaining({ toolId: "read", useCount: 2 }),
        expect.objectContaining({ toolId: "grep", useCount: 1 }),
      ])
      const read = result.all.tools.find((row) => row.toolId === "read")
      expect(read?.lastUsedAt).toBeGreaterThan(0)
      expect(result.sessionA.tools.map((row) => row.toolId)).toEqual(["read"])
    })
  })

  test("session attribution keeps the first session on conflict (v1 behavior)", async () => {
    await withTemp(async (directory) => {
      const result = await withStorage(directory, (storage) =>
        Effect.gen(function* () {
          yield* recordToolUsage(storage, "read", "ses_first")
          yield* recordToolUsage(storage, "read", "ses_second")
          return {
            first: yield* listToolUsage(storage, { session: "ses_first" }),
            second: yield* listToolUsage(storage, { session: "ses_second" }),
          }
        }),
      ).pipe(Effect.runPromise)

      expect(result.first.tools.map((row) => row.toolId)).toEqual(["read"])
      expect(result.second.tools).toEqual([])
    })
  })

  test("listToolUsage returns an empty result when the table is empty", async () => {
    await withTemp(async (directory) => {
      const result = await withStorage(directory, (storage) => listToolUsage(storage)).pipe(Effect.runPromise)
      expect(result).toEqual({ tools: [] })
    })
  })
})

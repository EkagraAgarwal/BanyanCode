import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Effect, Layer } from "effect"
import { aggregateSessionStats } from "../../src/cli/cmd/stats"
import { SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { tmpdir } from "../fixture/fixture"

test("aggregates session totals from the provided database", async () => {
  await using tmp = await tmpdir()
  // Stats walks `.banyancode/` subdirs of the cwd to find every DB.
  // Set up that layout here so the test mirrors production.
  const banyanDir = path.join(tmp.path, ".banyancode")
  await fs.mkdir(banyanDir, { recursive: true })
  const database = Database.layerFromPath(path.join(banyanDir, "banyancode.db"))
  const sessions = Layer.mock(Session.Service, {
    messages: () => Effect.succeed([]),
  })
  const now = Date.now()
  const projectID = ProjectV2.ID.make("project-stats")

  const stats = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make(tmp.path),
        sandboxes: [],
        time_created: now - 3_600_000,
        time_updated: now,
      })
      yield* db.insert(SessionTable).values([
        {
          id: SessionID.make("session-stats-1"),
          project_id: projectID,
          slug: "first",
          directory: tmp.path,
          title: "First",
          version: "test",
          cost: 1.25,
          tokens_input: 100,
          tokens_output: 50,
          tokens_reasoning: 10,
          tokens_cache_read: 20,
          tokens_cache_write: 5,
          time_created: now - 3_600_000,
          time_updated: now - 1_800_000,
        },
        {
          id: SessionID.make("session-stats-2"),
          project_id: projectID,
          slug: "second",
          directory: tmp.path,
          title: "Second",
          version: "test",
          cost: 0.75,
          tokens_input: 200,
          tokens_output: 75,
          tokens_reasoning: 15,
          tokens_cache_read: 30,
          tokens_cache_write: 10,
          time_created: now - 1_800_000,
          time_updated: now,
        },
      ])

      return yield* aggregateSessionStats(undefined, undefined, undefined, tmp.path)
    }).pipe(Effect.provide(Layer.mergeAll(database, sessions))),
  )

  expect(stats.totalSessions).toBe(2)
  expect(stats.totalCost).toBe(2)
  expect(stats.totalTokens).toEqual({
    input: 300,
    output: 125,
    reasoning: 25,
    cache: { read: 50, write: 15 },
  })
  expect(stats.tokensPerSession).toBe(257.5)
  expect(stats.days).toBe(1)
})

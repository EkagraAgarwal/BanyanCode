import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Banyan } from "@opencode-ai/core/banyancode"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const SESSION_ID = "session-perf"
const ROWS = 5000
// 64-char payload, unique per row so the key column stays the only
// shared discriminator for ranking assertions.
const payloadFor = (i: number) => `bench-payload-${String(i).padStart(4, "0")}-${"x".repeat(47)}`

describe("MemoryRepo.searchRanked — FTS perf (WS3)", () => {
  let tmp: Awaited<ReturnType<typeof tmpdir>>
  let dbPath: string
  const dbLayer = () => Database.layerFromPath(dbPath)
  const memoryLayer = () => Banyan.memoryRepoLayer

  const withRepo = <A>(fn: (repo: typeof Banyan.MemoryRepo.Service) => Effect.Effect<A, never, never>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Banyan.MemoryRepo
        return yield* fn(repo)
      }).pipe(Effect.provide(memoryLayer()), Effect.provide(dbLayer()), Effect.scoped),
    )

  beforeAll(async () => {
    tmp = await tmpdir()
    dbPath = path.join(tmp.path, "memory-fts-perf.sqlite")
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* Banyan.MemoryRepo
        for (let i = 0; i < ROWS; i++) {
          yield* repo.put({
            id: `bench-${i}`,
            key: `bench:key-${i}`,
            value: {
              kind: "bench",
              title: "Benchmark memory entry",
              body: payloadFor(i),
              source: { type: "system" },
              confidence: "low",
              importance: "low",
              status: "active",
            },
            scope: "session",
            sessionID: SESSION_ID,
          })
        }
        yield* repo.put({
          id: "global-marker",
          key: "glob:marker",
          value: {
            kind: "bench",
            title: "Global marker",
            body: "global scope marker entry",
            source: { type: "system" },
            confidence: "low",
            importance: "low",
            status: "active",
          },
          scope: "global",
        })
      }).pipe(Effect.provide(memoryLayer()), Effect.provide(dbLayer()), Effect.scoped),
    )
  }, 60_000)

  afterAll(async () => {
    await tmp?.[Symbol.asyncDispose]()
  })

  test("ranks a full-key query with the exact key first", async () => {
    const { entries, totalHits } = await withRepo((repo) =>
      repo.searchRanked({ query: "bench:key-4", scope: "session", sessionID: SESSION_ID, limit: 10 }),
    )
    expect(totalHits).toBeGreaterThanOrEqual(1)
    expect(entries.length).toBeLessThanOrEqual(10)
    // The exact-key row must be the highest-ranked of the top-10.
    expect(entries[0]?.key).toBe("bench:key-4")
  })

  test("trigram substring behavior: 'key-4' finds bench:key-4", async () => {
    // unicode61 requires whole-token matches, so a partial-key query like
    // this misses `bench:key-4`. Passing proves the trigram tokenizer
    // migration ran (fallback would still match, but only the unicode61
    // whole-token path — see fts-tokenize.test.ts for the codegraph analog).
    const { entries } = await withRepo((repo) =>
      repo.searchRanked({ query: "key-4", scope: "session", sessionID: SESSION_ID, limit: 10 }),
    )
    expect(entries.some((e) => e.key === "bench:key-4")).toBe(true)
  })

  test("completes well under the 1500ms CI bound", async () => {
    const start = performance.now()
    const result = await withRepo((repo) =>
      repo.searchRanked({ query: "bench:key-4", scope: "session", sessionID: SESSION_ID, limit: 10 }),
    )
    const elapsed = performance.now() - start
    expect(result.totalHits).toBeGreaterThanOrEqual(1)
    expect(elapsed).toBeLessThan(1500)
  })

  test("window-count totalHits reports the true match count past LIMIT", async () => {
    const { entries, totalHits } = await withRepo((repo) =>
      repo.searchRanked({ query: "bench:key-", scope: "session", sessionID: SESSION_ID, limit: 10 }),
    )
    // Every seeded key starts with `bench:key-`, so all 5000 match.
    expect(entries).toHaveLength(10)
    expect(totalHits).toBe(ROWS)
  })

  test("non-session (global) search still works", async () => {
    const { entries, totalHits } = await withRepo((repo) =>
      repo.searchRanked({ query: "glob:marker", scope: "global", limit: 5 }),
    )
    expect(totalHits).toBe(1)
    expect(entries[0]?.key).toBe("glob:marker")
    expect(entries[0]?.scope).toBe("global")
  })
})

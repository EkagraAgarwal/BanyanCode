import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import {
  SWARM_MODE_KEY,
  areShardsDisjoint,
  currentMaxSubagents,
  isSwarmMode,
  nextSwarmMode,
  partitionFiles,
  readSwarmMode,
  resolveWaveSize,
  runSwarmWaves,
  shardIdFor,
  swarmToggleMessage,
  type ShardResult,
  type SwarmShard,
} from "../../src/banyancode/swarm-waves"
import { MaxSubagents } from "../../src/banyancode/max-subagents"
import { BanyanConfigService } from "../../src/banyancode/banyan-config"
import { SubagentBus } from "../../src/banyancode/subagent-bus"
import { SubagentMessagesRepo } from "../../src/banyancode/subagent-messages-repo"
import { DEFAULT_MAX_SUBAGENTS, MAX_SUBAGENTS_LIMIT } from "../../src/v1/config/banyan-config"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import type { SubagentMessage } from "../../src/banyancode/types"

process.env.BANYANCODE_ENABLE = "1"

// Merge-preserving mock: unknown keys (e.g. banyancode_swarm_mode before it
// lands in BanyanConfig.Info) survive update/get, like the real service.
const makeMockConfig = (initial: Record<string, unknown> = {}) => {
  let state = { ...initial }
  return Layer.succeed(
    BanyanConfigService.Service,
    BanyanConfigService.Service.of({
      get: () => Effect.succeed(state as any),
      getGlobal: () => Effect.succeed(state as any),
      update: (patch: any) => Effect.succeed((state = { ...state, ...patch }) as any),
      updateAgentOverride: (_name: string, _patch: any) => Effect.succeed({ ...state } as any),
      getAgentOverrides: () => Effect.succeed([] as any),
      updateAgentPrompt: (_name: string, _prompt: string) => Effect.succeed({ ...state } as any),
    }),
  )
}

describe("swarm toggle helpers", () => {
  test("SWARM_MODE_KEY is the peer-owned config key", () => {
    expect(SWARM_MODE_KEY).toBe("banyancode_swarm_mode")
  })

  test("readSwarmMode is false unless explicitly true", () => {
    expect(readSwarmMode({})).toBe(false)
    expect(readSwarmMode(undefined)).toBe(false)
    expect(readSwarmMode(null)).toBe(false)
    expect(readSwarmMode({ [SWARM_MODE_KEY]: false })).toBe(false)
    expect(readSwarmMode({ [SWARM_MODE_KEY]: true })).toBe(true)
  })

  test("nextSwarmMode flips the current value", () => {
    expect(nextSwarmMode({})).toBe(true)
    expect(nextSwarmMode({ [SWARM_MODE_KEY]: true })).toBe(false)
  })

  test("swarmToggleMessage mirrors the yolo message shape", () => {
    expect(swarmToggleMessage(true)).toBe("Swarm mode is now on.")
    expect(swarmToggleMessage(false)).toBe("Swarm mode is now off.")
  })

  test("toggle round-trips off->on->off through update/get", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* BanyanConfigService.Service
        const first = nextSwarmMode(yield* svc.get())
        expect(first).toBe(true)
        yield* svc.update({ [SWARM_MODE_KEY]: first } as any)
        expect(readSwarmMode(yield* svc.get())).toBe(true)
        const second = nextSwarmMode(yield* svc.get())
        expect(second).toBe(false)
        yield* svc.update({ [SWARM_MODE_KEY]: second } as any)
        expect(readSwarmMode(yield* svc.get())).toBe(false)
      }).pipe(Effect.provide(makeMockConfig())),
    )
  })

  test("isSwarmMode reads the service, false when unavailable", async () => {
    const on = await Effect.runPromise(
      Effect.provide(isSwarmMode(), makeMockConfig({ [SWARM_MODE_KEY]: true })),
    )
    expect(on).toBe(true)
    const off = await Effect.runPromise(Effect.provide(isSwarmMode(), makeMockConfig()))
    expect(off).toBe(false)
    const absent = await Effect.runPromise(isSwarmMode())
    expect(absent).toBe(false)
  })

  test("currentMaxSubagents falls back to default without the service", async () => {
    const fallback = await Effect.runPromise(currentMaxSubagents())
    expect(fallback).toBe(DEFAULT_MAX_SUBAGENTS)
    const configured = await Effect.runPromise(
      Effect.provide(
        currentMaxSubagents(),
        MaxSubagents.layer.pipe(Layer.provide(makeMockConfig({ banyancode_max_subagents: 3 }))),
      ),
    )
    expect(configured).toBe(3)
  })
})

describe("swarm partitioning", () => {
  test("shardIds are deterministic from goalId+index", () => {
    expect(shardIdFor("goal1", 0)).toBe("goal1#0")
    expect(shardIdFor("goal1", 0)).toBe(shardIdFor("goal1", 0))
    expect(shardIdFor("goal1", 1)).not.toBe(shardIdFor("goal1", 0))
    expect(shardIdFor("goal2", 0)).not.toBe(shardIdFor("goal1", 0))
  })

  test("partitionFiles covers every file exactly once", () => {
    const files = ["a", "b", "c", "d", "e"]
    const shards = partitionFiles("goal1", files, 2)
    expect(shards.length).toBe(3)
    expect(shards.map((s) => s.shardId)).toEqual(["goal1#0", "goal1#1", "goal1#2"])
    expect(shards.flatMap((s) => [...s.filesOwned]).sort()).toEqual([...files].sort())
    expect(areShardsDisjoint(shards)).toBe(true)
  })

  test("areShardsDisjoint rejects overlapping ownership", () => {
    const shards: SwarmShard[] = [
      { shardId: "g#0", index: 0, filesOwned: ["a", "b"] },
      { shardId: "g#1", index: 1, filesOwned: ["b", "c"] },
    ]
    expect(areShardsDisjoint(shards)).toBe(false)
  })

  test("resolveWaveSize clamps to [1, min(max, limit)]", () => {
    expect(resolveWaveSize(undefined, 5)).toBe(5)
    expect(resolveWaveSize(3, 5)).toBe(3)
    expect(resolveWaveSize(0, 5)).toBe(1)
    expect(resolveWaveSize(99, 5)).toBe(5)
    expect(resolveWaveSize(99, 99)).toBe(MAX_SUBAGENTS_LIMIT)
    expect(resolveWaveSize(-2, 5)).toBe(1)
  })
})

describe("swarm waves", () => {
  test("concurrent subagents never exceed MaxSubagents when swarm is on", async () => {
    const shards = partitionFiles("goal-cap", ["a", "b", "c", "d", "e", "f", "g"], 1)
    await Effect.runPromise(
      Effect.gen(function* () {
        const current = yield* Ref.make(0)
        const peak = yield* Ref.make(0)
        const runShard = (shard: SwarmShard) =>
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(current, (v) => v + 1)
            yield* Ref.update(peak, (p) => Math.max(p, n))
            yield* Effect.sleep("15 millis")
            yield* Ref.update(current, (v) => v - 1)
            return {
              shardId: shard.shardId,
              status: "done",
              filesModified: [...shard.filesOwned],
            } as ShardResult
          })
        const results = yield* runSwarmWaves({
          goalId: "goal-cap",
          shards,
          swarmMode: true,
          maxConcurrent: 3,
          runShard,
        })
        expect(results.length).toBe(7)
        expect(results.every((r) => r.status === "done")).toBe(true)
        // Results stay in shard order even though waves overlap.
        expect(results.map((r) => r.shardId)).toEqual(shards.map((s) => s.shardId))
        expect(yield* Ref.get(peak)).toBeLessThanOrEqual(3)
      }),
    )
  })

  test("swarm off falls back to sequential single-shard delegation", async () => {
    const shards = partitionFiles("goal-seq", ["a", "b", "c", "d"], 1)
    await Effect.runPromise(
      Effect.gen(function* () {
        const current = yield* Ref.make(0)
        const peak = yield* Ref.make(0)
        const order: string[] = []
        const runShard = (shard: SwarmShard) =>
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(current, (v) => v + 1)
            yield* Ref.update(peak, (p) => Math.max(p, n))
            yield* Effect.sleep("5 millis")
            yield* Ref.update(current, (v) => v - 1)
            order.push(shard.shardId)
            return { shardId: shard.shardId, status: "done", filesModified: [] } as ShardResult
          })
        const results = yield* runSwarmWaves({
          goalId: "goal-seq",
          shards,
          swarmMode: false,
          maxConcurrent: 3,
          runShard,
        })
        expect(results.every((r) => r.status === "done")).toBe(true)
        expect(yield* Ref.get(peak)).toBe(1)
        expect(order).toEqual(shards.map((s) => s.shardId))
      }),
    )
  })

  test("per-shard timeout yields partial results without blocking fan-in", async () => {
    const shards = partitionFiles("goal-slow", ["a", "b", "c"], 1)
    await Effect.runPromise(
      Effect.gen(function* () {
        const runShard = (shard: SwarmShard) =>
          Effect.gen(function* () {
            if (shard.index === 1) yield* Effect.sleep("500 millis")
            return { shardId: shard.shardId, status: "done", filesModified: [] } as ShardResult
          })
        const results = yield* runSwarmWaves({
          goalId: "goal-slow",
          shards,
          swarmMode: true,
          maxConcurrent: 3,
          perShardTimeoutMs: 25,
          runShard,
        })
        expect(results[0].status).toBe("done")
        expect(results[1].status).toBe("partial")
        expect(results[1].error).toContain("timed out")
        expect(results[2].status).toBe("done")
      }),
    )
  })
})

describe("swarm shard idempotency", () => {
  test("shard publish retry returns created=false without duplicating", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "swarm-idem.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const messagesLayer = SubagentMessagesRepo.layer.pipe(Layer.provide(dbLayer))
    const busLayer = SubagentBus.layer.pipe(Layer.provide(messagesLayer), Layer.provide(dbLayer))
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const bus = yield* SubagentBus.Service
        const repo = yield* SubagentMessagesRepo.Service
        const msg = {
          id: "swarm_shard_goal9_0",
          parentSessionID: "ses_swarm_parent",
          fromSession: "ses_swarm_parent",
          fromAgent: "orchestrator",
          toAgent: "coder",
          kind: "plan",
          payload: { shardId: shardIdFor("goal9", 0) },
          createdAt: Date.now(),
        } satisfies SubagentMessage
        const first = yield* bus.publishOrFetch(msg)
        // A retry is a fresh attempt with a fresh timestamp but the same
        // deterministic shard id (goalId+index). The stored row must win:
        // created=false, original createdAt preserved, no duplicate row.
        const retry = yield* bus.publishOrFetch({ ...msg, createdAt: msg.createdAt + 1 })
        expect(first.created).toBe(true)
        expect(retry.created).toBe(false)
        expect(retry.id).toBe(first.id)
        expect(retry.createdAt).toBe(first.createdAt)
        expect((yield* repo.listByParent("ses_swarm_parent", false)).length).toBe(1)
      }).pipe(Effect.provide(Layer.mergeAll(dbLayer, messagesLayer, busLayer))),
    )
  })
})

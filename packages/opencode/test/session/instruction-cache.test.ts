import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { NodeFileSystem } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"

import {
  Instruction,
  TtlCache,
  createRemoteInstructionCache,
  INSTRUCTION_DISCOVERY_TTL_MS,
  REMOTE_INSTRUCTION_TTL_MS,
  REMOTE_INSTRUCTION_NEGATIVE_TTL_MS,
} from "../../src/session/instruction"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceRef } from "../../src/effect/instance-ref"
import type * as Project from "../../src/project/project"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, NodeFileSystem.layer))

const instructionLayerWith = (
  global: Partial<Global.Interface>,
  configValue: Record<string, unknown>,
  flags: Partial<RuntimeFlags.Info> = {},
) =>
  Instruction.layer.pipe(
    Layer.provide(TestConfig.layer({ get: () => Effect.succeed(configValue) })),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Global.layerWith(global)),
    Layer.provide(RuntimeFlags.layer(flags)),
  )

const provideInstructionWith =
  (dir: string, global: Partial<Global.Interface>, configValue: Record<string, unknown>, flags?: Partial<RuntimeFlags.Info>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(
      Effect.provide(instructionLayerWith(global, configValue, flags)),
      // DB-free instance: InstanceState (ScopedCache) only needs InstanceRef, so the
      // R8 live tests bypass the DB-backed InstanceStore fixture and never touch the
      // shared worktree database.
      Effect.provideService(InstanceRef, { directory: dir, worktree: dir, project: {} as Project.Info }),
    )

describe("TtlCache", () => {
  test("returns undefined for missing keys", () => {
    const cache = new TtlCache<string, string>(() => 0)
    expect(cache.get("missing")).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  test("expires entries past the TTL", () => {
    let now = 1000
    const cache = new TtlCache<string, string>(() => now)
    cache.set("k", "v", 100)
    expect(cache.get("k")).toBe("v")
    now += 99
    expect(cache.get("k")).toBe("v")
    now += 1
    expect(cache.get("k")).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  test("evicts the oldest entry past maxSize", () => {
    const cache = new TtlCache<string, number>(() => 0, 2)
    cache.set("a", 1, 1000)
    cache.set("b", 2, 1000)
    cache.set("c", 3, 1000)
    expect(cache.get("a")).toBeUndefined()
    expect(cache.get("b")).toBe(2)
    expect(cache.get("c")).toBe(3)
  })

  test("clear drops everything", () => {
    const cache = new TtlCache<string, string>(() => 0)
    cache.set("a", "1", 1000)
    cache.set("b", "2", 1000)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get("a")).toBeUndefined()
  })
})

describe("createRemoteInstructionCache", () => {
  test("successes outlive failures and failures are retried after the negative TTL", () => {
    let now = 0
    const cache = createRemoteInstructionCache(() => now)
    cache.setFailure("http://down/x")
    cache.setSuccess("http://up/y", "body")
    expect(cache.get("http://down/x")).toBe("")
    expect(cache.get("http://up/y")).toBe("body")

    now += REMOTE_INSTRUCTION_NEGATIVE_TTL_MS
    expect(cache.get("http://down/x")).toBeUndefined()
    expect(cache.get("http://up/y")).toBe("body")

    now += REMOTE_INSTRUCTION_TTL_MS
    expect(cache.get("http://up/y")).toBeUndefined()
  })

  test("a later success overwrites a cached failure", () => {
    let now = 0
    const cache = createRemoteInstructionCache(() => now)
    cache.setFailure("http://flaky/x")
    cache.setSuccess("http://flaky/x", "recovered")
    expect(cache.get("http://flaky/x")).toBe("recovered")
    now += REMOTE_INSTRUCTION_NEGATIVE_TTL_MS
    expect(cache.get("http://flaky/x")).toBe("recovered")
  })

  test("TTL constants match the documented windows", () => {
    expect(INSTRUCTION_DISCOVERY_TTL_MS).toBe(5_000)
    expect(REMOTE_INSTRUCTION_TTL_MS).toBe(60_000)
    expect(REMOTE_INSTRUCTION_NEGATIVE_TTL_MS).toBe(10_000)
  })
})

describe("Instruction R8 caches", () => {
  it.live("second system() within the window performs no file reads", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const agents = path.join(dir, "AGENTS.md")
        yield* fs.writeFileString(agents, "# v1")

        const svc = yield* Instruction.Service
        const first = yield* svc.system()
        expect(first).toHaveLength(1)
        expect(first[0]).toContain("# v1")

        // Rewrite behind the cache's back: a re-read would observe v2.
        yield* fs.writeFileString(agents, "# v2")
        const second = yield* svc.system()
        expect(second).toEqual(first)
      }).pipe(provideInstructionWith(dir, { home: dir, config: dir }, {}))
    }),
  )

  it.live("invalidate() drops discovery + system caches", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const agents = path.join(dir, "AGENTS.md")
        yield* fs.writeFileString(agents, "# v1")

        const svc = yield* Instruction.Service
        expect((yield* svc.system())[0]).toContain("# v1")

        yield* fs.writeFileString(agents, "# v2")
        expect((yield* svc.system())[0]).toContain("# v1")

        yield* svc.invalidate()
        const after = yield* svc.system()
        expect(after).toHaveLength(1)
        expect(after[0]).toContain("# v2")
      }).pipe(provideInstructionWith(dir, { home: dir, config: dir }, {}))
    }),
  )

  it.live("remote instruction bodies are fetched once per window", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      let hits = 0
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch: () => {
              hits += 1
              return new Response("# Remote")
            },
          }),
        ),
        (s) => Effect.sync(() => s.stop()),
      )
      const url = `http://127.0.0.1:${server.port}/instructions.md`
      return yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const first = yield* svc.system()
        expect(first).toHaveLength(1)
        expect(first[0]).toContain("# Remote")
        expect(hits).toBe(1)

        const second = yield* svc.system()
        expect(second).toEqual(first)
        expect(hits).toBe(1)

        yield* svc.invalidate()
        const third = yield* svc.system()
        expect(third).toEqual(first)
        expect(hits).toBe(2)
      }).pipe(provideInstructionWith(dir, { home: dir, config: dir }, { instructions: [url] }))
    }),
  )
})

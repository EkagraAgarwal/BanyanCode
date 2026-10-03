import { describe, expect, test } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { registerDisposer } from "../../src/effect/instance-registry"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.void }),
)

// Fake project service: the eviction mechanics don't need the real project
// database (which also keeps these tests off the globally-locked DB file).
const fakeProject = Layer.mock(Project.Service, {
  fromDirectory: (directory: string) =>
    Effect.succeed({
      project: {
        id: "test-project",
        worktree: directory,
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      } as unknown as Project.Info,
      sandbox: directory,
    }),
})

const evictionLayer = (options: InstanceStore.EvictionOptions) =>
  Layer.mergeAll(
    InstanceStore.layerWithOptions(options).pipe(Layer.provide(fakeProject)),
    CrossSpawnSpawner.defaultLayer,
  ).pipe(Layer.provide(noopBootstrap))

const scopedDisposer = (disposed: Array<string>) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      registerDisposer(async (directory) => {
        disposed.push(directory)
      }),
    ),
    (off) => Effect.sync(off),
  )

const wasDisposed = (disposed: Array<string>, directory: string) =>
  Effect.gen(function* () {
    return disposed.includes(directory) ? (true as const) : undefined
  })

describe("resolveInstanceIdleMs/resolveInstanceSweepMs", () => {
  test("idle falls back to the 15 min default, sweep to 60 s", () => {
    expect(InstanceStore.resolveInstanceIdleMs(undefined)).toBe(15 * 60 * 1000)
    expect(InstanceStore.resolveInstanceIdleMs("fast")).toBe(15 * 60 * 1000)
    expect(InstanceStore.resolveInstanceIdleMs(0)).toBe(15 * 60 * 1000)
    expect(InstanceStore.resolveInstanceIdleMs(1500.9)).toBe(1500)
    expect(InstanceStore.resolveInstanceSweepMs(undefined)).toBe(60 * 1000)
    expect(InstanceStore.resolveInstanceSweepMs("fast")).toBe(60 * 1000)
    expect(InstanceStore.resolveInstanceSweepMs(0)).toBe(0)
    expect(InstanceStore.resolveInstanceSweepMs("0")).toBe(0)
    expect(InstanceStore.resolveInstanceSweepMs(500)).toBe(500)
  })
})

describe("InstanceStore idle eviction", () => {
  const it = testEffect(evictionLayer({ idleMs: 100, sweepMs: 25 }))

  it.live("evicts an idle instance through disposeDirectory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const disposed: Array<string> = []
      yield* scopedDisposer(disposed)
      const store = yield* InstanceStore.Service
      const first = yield* store.load({ directory: dir })
      expect(first.directory).toBe(dir)

      yield* pollWithTimeout(wasDisposed(disposed, dir), "idle instance was never evicted")

      // Eviction went through disposeEntry, so the cache no longer holds it:
      // the next load boots a fresh context.
      const second = yield* store.load({ directory: dir })
      expect(second).not.toBe(first)
    }),
  )

  it.live("a fresh load is not evicted before its TTL", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const disposed: Array<string> = []
      yield* scopedDisposer(disposed)
      const store = yield* InstanceStore.Service
      // Each load refreshes lastActive; keep touching so the TTL never lapses.
      for (let i = 0; i < 5; i++) {
        yield* store.load({ directory: dir })
        yield* Effect.sleep("50 millis")
      }
      expect(disposed).toEqual([])
    }),
  )
})

describe("InstanceStore eviction guard rails", () => {
  const itBusy = testEffect(evictionLayer({ idleMs: 100, sweepMs: 25, isBusy: () => Effect.succeed(true) }))

  itBusy.live("never evicts a busy instance", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const disposed: Array<string> = []
      yield* scopedDisposer(disposed)
      const store = yield* InstanceStore.Service
      const first = yield* store.load({ directory: dir })

      yield* Effect.sleep("400 millis")

      expect(disposed).toEqual([])
      expect(yield* store.load({ directory: dir })).toBe(first)
    }),
  )

  const itPinned = testEffect(evictionLayer({ idleMs: 100, sweepMs: 25 }))

  itPinned.live("never evicts the current-directory instance", () =>
    Effect.gen(function* () {
      const disposed: Array<string> = []
      yield* scopedDisposer(disposed)
      const store = yield* InstanceStore.Service
      // process.cwd() is always pinned: even long past the TTL it stays.
      const ctx = yield* store.load({ directory: process.cwd() })

      yield* Effect.sleep("400 millis")

      expect(disposed).toEqual([])
      expect(yield* store.load({ directory: process.cwd() })).toBe(ctx)
    }),
  )
})

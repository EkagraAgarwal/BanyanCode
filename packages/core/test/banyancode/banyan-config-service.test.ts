import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import * as path from "path"
import { layer as banyanConfigLayer, Service as BanyanConfigService } from "../../src/banyancode/banyan-config"
import { FSUtil } from "../../src/fs-util"
import { EffectFlock } from "../../src/util/effect-flock"
import { tmpdir } from "../fixture/tmpdir"

interface Counts {
  reads: number
  stats: number
}

// FSUtil wrapper that counts read/stat syscalls while delegating everything
// to the real implementation, so tests observe cache hits vs real re-reads.
const countingFs = (counts: Counts) =>
  Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const real = yield* FSUtil.Service
      const readFileStringSafe = Effect.fn("TestCounting.readFileStringSafe")(function* (file: string) {
        counts.reads++
        return yield* real.readFileStringSafe(file)
      })
      const stat = Effect.fn("TestCounting.stat")(function* (file: string) {
        counts.stats++
        return yield* real.stat(file)
      })
      return FSUtil.Service.of({ ...real, readFileStringSafe, stat })
    }),
  ).pipe(Layer.provide(FSUtil.defaultLayer))

const buildLayer = (counts: Counts) =>
  banyanConfigLayer.pipe(Layer.provide(Layer.mergeAll(countingFs(counts), EffectFlock.defaultLayer)))

const writeLocal = (dir: string, config: Record<string, unknown>) =>
  Bun.write(path.join(dir, "banyancode.json"), JSON.stringify(config))

describe("BanyanConfigService cache (W1.3 + W1.4)", () => {
  test("cache hit performs stats but no re-reads", async () => {
    await using tmp = await tmpdir()
    await writeLocal(tmp.path, { banyancode_max_subagents: 7 })
    const counts: Counts = { reads: 0, stats: 0 }
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* BanyanConfigService
        const first = yield* svc.get(tmp.path)
        const readsAfterFirst = counts.reads
        const statsAfterFirst = counts.stats
        const second = yield* svc.get(tmp.path)
        return {
          first,
          second,
          readsAfterFirst,
          statsAfterFirst,
          readsAfterSecond: counts.reads,
          statsAfterSecond: counts.stats,
        }
      }).pipe(Effect.provide(buildLayer(counts))),
    )
    expect(seen.first.banyancode_max_subagents).toBe(7)
    expect(seen.second).toEqual(seen.first)
    expect(seen.readsAfterFirst).toBeGreaterThan(0)
    // Second get for the same directory must not read any file again...
    expect(seen.readsAfterSecond).toBe(seen.readsAfterFirst)
    // ...but invalidation still stats each candidate file (one syscall each).
    expect(seen.statsAfterSecond).toBeGreaterThan(seen.statsAfterFirst)
  })

  test("mtime change invalidates the cache entry", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "banyancode.json")
    await writeLocal(tmp.path, { banyancode_max_subagents: 7 })
    const counts: Counts = { reads: 0, stats: 0 }
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* BanyanConfigService
        const first = yield* svc.get(tmp.path)
        const readsAfterFirst = counts.reads
        yield* Effect.promise(() => Bun.write(file, JSON.stringify({ banyancode_max_subagents: 12 })))
        // Deterministic mtime bump: same-size payloads can share an mtime tick.
        yield* Effect.promise(() => fs.utimes(file, new Date(), new Date(Date.now() + 5000)))
        const second = yield* svc.get(tmp.path)
        return { first, second, readsAfterFirst, readsAfterSecond: counts.reads }
      }).pipe(Effect.provide(buildLayer(counts))),
    )
    expect(seen.first.banyancode_max_subagents).toBe(7)
    expect(seen.second.banyancode_max_subagents).toBe(12)
    expect(seen.readsAfterSecond).toBeGreaterThan(seen.readsAfterFirst)
  })

  test("cache is keyed per directory; omitted directory keeps cwd behavior", async () => {
    await using tmpA = await tmpdir()
    await using tmpB = await tmpdir()
    await writeLocal(tmpA.path, { banyancode_max_subagents: 5 })
    await writeLocal(tmpB.path, { banyancode_max_subagents: 6 })
    const counts: Counts = { reads: 0, stats: 0 }
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* BanyanConfigService
        const a1 = yield* svc.get(tmpA.path)
        const b1 = yield* svc.get(tmpB.path)
        const readsAfterB = counts.reads
        const a2 = yield* svc.get(tmpA.path)
        const readsAfterA2 = counts.reads
        const fromCwdDefault = yield* svc.get()
        const fromCwdExplicit = yield* svc.get(process.cwd())
        return { a1, b1, a2, readsAfterB, readsAfterA2, fromCwdDefault, fromCwdExplicit }
      }).pipe(Effect.provide(buildLayer(counts))),
    )
    // Each project gets its own local config, never the other's.
    expect(seen.a1.banyancode_max_subagents).toBe(5)
    expect(seen.b1.banyancode_max_subagents).toBe(6)
    expect(seen.a2.banyancode_max_subagents).toBe(5)
    // Re-reading A after B served A from A's cache entry: no new reads.
    expect(seen.readsAfterA2).toBe(seen.readsAfterB)
    // No directory still resolves from the launcher cwd, as before.
    expect(seen.fromCwdDefault).toEqual(seen.fromCwdExplicit)
  })
})

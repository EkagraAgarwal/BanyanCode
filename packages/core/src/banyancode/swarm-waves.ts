export * as SwarmWaves from "./swarm-waves"

import { Duration, Effect, Option } from "effect"
import { BanyanConfigService } from "./banyan-config"
import { MaxSubagents } from "./max-subagents"
import { DEFAULT_MAX_SUBAGENTS, MAX_SUBAGENTS_LIMIT } from "../v1/config/banyan-config"

/**
 * Toggle-gated fan-out primitive for swarm mode (P0 slice).
 *
 * - Swarm OFF: single-shard fallback — shards run sequentially (concurrency
 *   1), i.e. normal delegation, behavior unchanged.
 * - Swarm ON: shards run in waves where concurrent subagents NEVER exceed the
 *   resolved MaxSubagents cap. The cap is consumed read-only from
 *   `MaxSubagents.Service` (same `serviceOption` + default pattern as
 *   `MeshCoordinator.tryReserveSubagentSlot`); callers still reserve real
 *   slots via `tryReserveSubagentSlot` before spawning.
 *
 * Lead-owns-commits discipline (AGENTS.md): each shard declares disjoint
 * `filesOwned`; coders return `filesModified` and never commit; the lead
 * commits sequentially per shard. Dispatch uses the existing
 * `mesh_control.plan_for` + `subagent_message` kinds only — this module adds
 * no agent types and no protocol changes. Per-shard timeout yields a
 * `partial` result so a straggler never blocks fan-in; refinements are new
 * shards referencing prior shard ids.
 */

export const SWARM_MODE_KEY = "banyancode_swarm_mode" as const

export const readSwarmMode = (config: unknown): boolean => {
  if (typeof config !== "object" || config === null) return false
  return (config as Record<string, unknown>)[SWARM_MODE_KEY] === true
}

export const nextSwarmMode = (config: unknown): boolean => !readSwarmMode(config)

export const swarmToggleMessage = (on: boolean): string => `Swarm mode is now ${on ? "on" : "off"}.`

export const isSwarmMode = Effect.fn("SwarmWaves.isSwarmMode")(function* () {
  const option = yield* Effect.serviceOption(BanyanConfigService.Service)
  if (Option.isNone(option)) return false
  return readSwarmMode(yield* option.value.get())
})

export const currentMaxSubagents = Effect.fn("SwarmWaves.currentMaxSubagents")(function* () {
  const option = yield* Effect.serviceOption(MaxSubagents.Service)
  if (Option.isSome(option)) return yield* option.value.current()
  return DEFAULT_MAX_SUBAGENTS
})

export interface SwarmShard {
  readonly shardId: string
  readonly index: number
  readonly filesOwned: readonly string[]
  readonly title?: string
  readonly exitCriteria?: string
}

export type ShardStatus = "done" | "partial" | "failed"

export interface ShardResult {
  readonly shardId: string
  readonly status: ShardStatus
  readonly filesModified: readonly string[]
  readonly verdict?: string
  readonly error?: string
}

/** Deterministic shard id: goalId + index, so retries reuse the same key. */
export const shardIdFor = (goalId: string, index: number): string => `${goalId}#${index}`

/** Chunk a file list into disjoint shards of at most `waveSize` files each. */
export const partitionFiles = (
  goalId: string,
  files: readonly string[],
  waveSize: number,
): SwarmShard[] => {
  const size = Math.max(1, Math.floor(waveSize))
  const shards: SwarmShard[] = []
  for (let i = 0; i < files.length; i += size) {
    const index = shards.length
    shards.push({ shardId: shardIdFor(goalId, index), index, filesOwned: files.slice(i, i + size) })
  }
  return shards
}

/** True when no file is owned by more than one shard. */
export const areShardsDisjoint = (shards: readonly SwarmShard[]): boolean => {
  const seen = new Set<string>()
  for (const shard of shards) {
    for (const file of shard.filesOwned) {
      if (seen.has(file)) return false
      seen.add(file)
    }
  }
  return true
}

/** Clamp the wave size to [1, min(max, MAX_SUBAGENTS_LIMIT)]. */
export const resolveWaveSize = (requested: number | undefined, max: number): number => {
  const cap = Math.min(Math.max(1, Math.floor(max)), MAX_SUBAGENTS_LIMIT)
  if (requested === undefined) return cap
  return Math.min(Math.max(1, Math.floor(requested)), cap)
}

export interface RunSwarmWavesInput<R> {
  readonly goalId: string
  readonly shards: readonly SwarmShard[]
  readonly swarmMode: boolean
  readonly maxConcurrent: number
  readonly perShardTimeoutMs?: number
  readonly runShard: (shard: SwarmShard) => Effect.Effect<ShardResult, never, R>
}

const timeoutResult = (shard: SwarmShard, perShardTimeoutMs: number): ShardResult => ({
  shardId: shard.shardId,
  status: "partial",
  filesModified: [],
  error: `shard timed out after ${perShardTimeoutMs}ms`,
})

export function runSwarmWaves<R>(input: RunSwarmWavesInput<R>): Effect.Effect<ShardResult[], never, R> {
  return Effect.gen(function* () {
    const concurrency = input.swarmMode ? resolveWaveSize(undefined, input.maxConcurrent) : 1
    return yield* Effect.forEach(
      input.shards,
      (shard) =>
        Effect.gen(function* () {
          if (input.perShardTimeoutMs === undefined) return yield* input.runShard(shard)
          const result = yield* input
            .runShard(shard)
            .pipe(Effect.timeout(Duration.millis(input.perShardTimeoutMs)), Effect.option)
          return Option.isSome(result) ? result.value : timeoutResult(shard, input.perShardTimeoutMs)
        }),
      { concurrency },
    )
  })
}

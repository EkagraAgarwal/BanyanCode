import type { Context } from "@opencode/plugin/effect/plugin"
import { Goal } from "@opencode/schema/goal"
import { Effect, type Scope, Schedule, Stream } from "effect"
import type { Loaded } from "../config/index.js"
import { apply, loadVariants, snapshot, type AgentState } from "./apply.js"
import { makeGoalTool, settingsFromConfig } from "./goal-tool.js"
import { register as registerOrchestration } from "./orchestration.js"

export interface AgentDeps {
  readonly config: { readonly get: () => Effect.Effect<Loaded> }
}

export { apply, applyOverrides, loadVariants, parseModelRef, permissionRules, snapshot } from "./apply.js"
export type { AgentState } from "./apply.js"
export { definitions } from "./definitions.js"
export type { AgentSpec } from "./definitions.js"
export { LADDER, MAPPING, resolveThinkingVariant, resolveVariant } from "./thinking.js"

/**
 * `banyancode.json` has no watcher in the config service (it re-reads on every
 * call), so the plugin decides when to refresh. `filesystem.changed` covers
 * project edits, `config.updated`/`model.updated` cover host reloads, and the
 * slow poll catches global config edits the location watcher never sees.
 */
const POLL = "15 seconds"

const isBanyanConfig = (file: string) => /(^|[\\/])banyancode\.jsonc?$/.test(file)

const fingerprint = (loaded: Loaded, state: AgentState) =>
  JSON.stringify([
    loaded.config,
    loaded.sources.map((source) => source.file),
    [...state.variants.entries()],
  ])

/**
 * Register the BanyanCode agent set and its `banyancode.json` overrides.
 *
 * Ordering: this runs from the `banyancode` built-in plugin, which the host
 * activates after core's built-in agents and before the config/markdown agent
 * plugin. So these defaults win over core's, and the user's configured
 * permissions, `agents` entries and markdown agents win over these.
 *
 * Transform callbacks are synchronous, so every read happens here: the snapshot
 * is refreshed whenever the config or model catalog changes, then
 * `ctx.agent.reload()` rematerializes the registry.
 */
export const register = (ctx: Context, deps: AgentDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state: { current?: AgentState; fingerprint?: string } = {}

    // v1's goal tuning keys are accepted by the config schema but v2's goal
    // plugin owns the loop, so push them over its RPC whenever they change.
    const goals = ctx.rpc(Goal.Definition)
    let goalSettings: string | undefined
    const configureGoal = (config: Loaded["config"]) =>
      Effect.gen(function* () {
        const next = settingsFromConfig(config)
        const key = JSON.stringify(next)
        if (key === goalSettings) return
        yield* goals.configure(next)
        goalSettings = key
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("banyancode: failed to configure the goal loop", { cause })),
      )

    /** Rebuild the snapshot; true when anything the transform depends on changed. */
    const refresh = Effect.gen(function* () {
      const loaded = yield* deps.config.get()
      yield* configureGoal(loaded.config)
      const variants = yield* loadVariants(ctx.model)
      const next = snapshot(loaded.config, variants)
      const nextFingerprint = fingerprint(loaded, next)
      if (nextFingerprint === state.fingerprint) return false
      state.current = next
      state.fingerprint = nextFingerprint
      return true
    })

    const sync = refresh.pipe(Effect.flatMap((changed) => (changed ? ctx.agent.reload() : Effect.void)))

    yield* refresh

    yield* ctx.agent.transform((editor) => {
      if (state.current !== undefined) apply(editor, state.current)
    })

    // v1 parity: the orchestration policy block is appended for every agent,
    // rendered from the current `banyancode_max_subagents`.
    yield* registerOrchestration(ctx, deps)

    // v1 `goal` tool bridged onto v2's native goal mode.
    yield* ctx.tool
      .transform((editor) => {
        editor.add(makeGoalTool(ctx))
      })
      .pipe(Effect.orDie)

    yield* ctx.event.subscribe({ types: ["config.updated", "model.updated", "filesystem.changed"] }).pipe(
      Stream.filter((event) => event.type !== "filesystem.changed" || isBanyanConfig(event.data.file)),
      Stream.debounce("100 millis"),
      Stream.runForEach(() => sync),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* sync.pipe(Effect.repeat(Schedule.spaced(POLL)), Effect.forkScoped({ startImmediately: true }))
  })

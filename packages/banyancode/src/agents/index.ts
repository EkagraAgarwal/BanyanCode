import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, type Scope, Schedule, Stream } from "effect"
import type { Loaded } from "../config/index.js"
import { apply, loadVariants, snapshot, type AgentState } from "./apply.js"

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
 * activates after the config/markdown agent plugin and after core's built-in
 * agents, so our transform is appended (and therefore wins) where they
 * conflict. `banyancode.json` per-agent overrides are applied last.
 *
 * Transform callbacks are synchronous, so every read happens here: the snapshot
 * is refreshed whenever the config or model catalog changes, then
 * `ctx.agent.reload()` rematerializes the registry.
 */
export const register = (ctx: Context, deps: AgentDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state: { current?: AgentState; fingerprint?: string } = {}

    /** Rebuild the snapshot; true when anything the transform depends on changed. */
    const refresh = Effect.gen(function* () {
      const loaded = yield* deps.config.get()
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

    yield* ctx.event.subscribe({ types: ["config.updated", "model.updated", "filesystem.changed"] }).pipe(
      Stream.filter((event) => event.type !== "filesystem.changed" || isBanyanConfig(event.data.file)),
      Stream.debounce("100 millis"),
      Stream.runForEach(() => sync),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* sync.pipe(Effect.repeat(Schedule.spaced(POLL)), Effect.forkScoped({ startImmediately: true }))
  })

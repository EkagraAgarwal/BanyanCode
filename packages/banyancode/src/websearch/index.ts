import type { Context } from "@opencode/plugin/effect/plugin"
import type { WebSearchEditor } from "@opencode/plugin/effect/websearch"
import { Effect, type Scope, Schedule, Stream } from "effect"
import type { Loaded } from "../config/index.js"
import { definition, PROVIDER_ID } from "./duckduckgo.js"

export interface WebsearchDeps {
  readonly config: { readonly get: () => Effect.Effect<Loaded> }
}

export interface WebsearchState {
  readonly disabled: boolean
}

export { buildUrl, DDG_URL, definition, MAX_RESULTS, PROVIDER_ID, PROVIDER_NAME, toResults } from "./duckduckgo.js"
export { parse } from "./parse.js"
export type { ParsedResult } from "./parse.js"

const POLL = "15 seconds"

const isBanyanConfig = (file: string) => /(^|[\\/])banyancode\.jsonc?$/.test(file)

/**
 * Resolve the disable switch. v1 checked `BANYANCODE_DISABLE_WEBSEARCH=1` only,
 * and `BANYANCODE_ENABLE=0` turns the whole BanyanCode surface off. The
 * `banyancode_disable_websearch` config key is the per-project equivalent.
 */
export const websearchState = (
  config: Loaded["config"],
  env: Readonly<Record<string, string | undefined>> = process.env,
): WebsearchState => ({
  disabled:
    env.BANYANCODE_ENABLE === "0" ||
    env.BANYANCODE_DISABLE_WEBSEARCH === "1" ||
    config.banyancode_disable_websearch === true,
})

/**
 * Add the free DuckDuckGo provider and claim the default.
 *
 * Default rules:
 * - `banyancode_disable_websearch` / `BANYANCODE_DISABLE_WEBSEARCH=1` registers
 *   nothing at all (other configured providers keep working; v1 disabled only
 *   the free tool).
 * - An existing transform-registered default is left alone. `opencode.json`
 *   `websearch.provider` is applied by the config plugin, which registers after
 *   this one, so an explicitly configured provider always wins.
 * - A persisted runtime selection (the provider picker) is invisible to plugins;
 *   claiming the default here shadows it. The product default is intended to be
 *   DuckDuckGo, and `websearch.provider` remains the supported override.
 */
export const applyWebsearch = (editor: WebSearchEditor, state: WebsearchState) => {
  if (state.disabled) return
  editor.add(definition)
  if (editor.default.get() === undefined) editor.default.set(PROVIDER_ID)
}

/**
 * Register the DuckDuckGo provider.
 *
 * The transform is synchronous, so the disable switch is captured in a mutable
 * snapshot first. `banyancode.json` has no watcher in the config service, so we
 * refresh on `config.updated`, on a `banyancode.json` filesystem event, and on a
 * slow poll for global config edits, then reload the provider domain.
 */
export const register = (ctx: Context, deps: WebsearchDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const current: { state?: WebsearchState; flag?: boolean } = {}

    /** Re-read the disable switch; true when it changed. */
    const refresh = Effect.gen(function* () {
      const loaded = yield* deps.config.get()
      const next = websearchState(loaded.config)
      if (next.disabled === current.flag) return false
      current.state = next
      current.flag = next.disabled
      return true
    })

    const sync = refresh.pipe(Effect.flatMap((changed) => (changed ? ctx.websearch.reload() : Effect.void)))

    yield* refresh

    yield* ctx.websearch.transform((editor) => {
      if (current.state !== undefined) applyWebsearch(editor, current.state)
    })

    yield* ctx.event.subscribe({ types: ["config.updated", "filesystem.changed"] }).pipe(
      Stream.filter((event) => event.type !== "filesystem.changed" || isBanyanConfig(event.data.file)),
      Stream.debounce("100 millis"),
      Stream.runForEach(() => sync),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* sync.pipe(Effect.repeat(Schedule.spaced(POLL)), Effect.forkScoped({ startImmediately: true }))
  })

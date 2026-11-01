import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, type Scope } from "effect"
import type { Interface as ConfigInterface } from "../config/service.js"
import type { WriteTarget } from "../config/writer.js"
import { update } from "../config/writer.js"

/**
 * v1 slash commands owned by workstream 3e that had no v2 registration yet:
 * `/yolo`, `/lsp`, `/websearch-free` and the persisted `/max-subagents`.
 *
 * `/swarm` is registered by `src/mesh/commands.ts`; its no-argument toggle
 * still updates in-memory state only. The writer exported from
 * `src/config/writer.ts` is what that command should call
 * (`banyancode_swarm_mode`) — see `specs/banyancode/v2-parity-gaps.md`.
 */

export const YOLO_COMMAND = "yolo"
export const LSP_COMMAND = "lsp"
export const WEBSEARCH_FREE_COMMAND = "websearch-free"
export const MAX_SUBAGENTS_COMMAND = "max-subagents"

export const YOLO_DESCRIPTION = "toggle YOLO mode (auto-approve all permissions, including dangerous)"
export const LSP_DESCRIPTION =
  "toggle BanyanCode LSP servers (banyancode_lsp); with no arg, prints the current value"
export const WEBSEARCH_FREE_DESCRIPTION = "search the web using DuckDuckGo HTML"
export const MAX_SUBAGENTS_DESCRIPTION =
  "set max concurrent subagents (1-20); with no arg, prints the current value"

const USAGE_LSP = "Usage: /lsp <on|off|toggle>"
const USAGE_MAX = "Usage: /max-subagents <1-20>"

const switchValue = (text: string): "on" | "off" | "toggle" | undefined => {
  const value = text.trim().toLowerCase()
  if (value === "on" || value === "true" || value === "enable" || value === "enabled") return "on"
  if (value === "off" || value === "false" || value === "disable" || value === "disabled") return "off"
  if (value === "toggle") return "toggle"
  return undefined
}

const lspIsOn = (value: unknown): boolean => value === true || (typeof value === "object" && value !== null)

export const WEBSEARCH_FREE_TEMPLATE = [
  "Search the web using DuckDuckGo HTML.",
  "",
  "Usage: /websearch-free <query>",
  "",
  "Useful for current information beyond the model's knowledge cutoff. Returns a list of search results with title, URL, and snippet.",
  "",
  "- <query>: free-form search query (required)",
  "",
  "Each session is rate-limited to keep requests polite. If the search is slow, try a more specific query.",
].join("\n")

export interface CommandDeps {
  readonly config: ConfigInterface
  readonly target: WriteTarget
  readonly session: Context["session"]
  readonly maxSubagentsLimit: number
  readonly maxSubagentsDefault: number
}

const notify = (deps: CommandDeps, sessionID: string, text: string, description: string): Effect.Effect<void> =>
  deps.session
    .synthetic({ sessionID: sessionID as never, text, description })
    .pipe(Effect.asVoid, Effect.catchCause(() => Effect.void))

export const registerCommands = (ctx: Context, deps: CommandDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* ctx.command
      .transform((editor) => {
        editor.add({
          name: YOLO_COMMAND,
          description: YOLO_DESCRIPTION,
          execute: (input) =>
            Effect.gen(function* () {
              const loaded = yield* deps.config.get()
              const current = loaded.config.banyancode_yolo_mode === true
              const arg = input.prompt.text.trim().toLowerCase()
              const next =
                arg.length === 0 || arg === "toggle"
                  ? !current
                  : arg === "on" || arg === "true"
                    ? true
                    : arg === "off" || arg === "false"
                      ? false
                      : undefined
              if (next === undefined) {
                yield* notify(deps, input.sessionID, `Unknown argument "${arg}". Usage: /yolo <on|off|toggle>`, "YOLO mode")
                return
              }
              yield* Effect.promise(() => update(deps.target, { banyancode_yolo_mode: next }))
              yield* notify(deps, input.sessionID, `YOLO mode is now ${next ? "on" : "off"}.`, "YOLO mode")
            }).pipe(Effect.asVoid),
        })

        editor.add({
          name: LSP_COMMAND,
          description: LSP_DESCRIPTION,
          execute: (input) =>
            Effect.gen(function* () {
              const loaded = yield* deps.config.get()
              const raw = loaded.config.banyancode_lsp
              const current = lspIsOn(raw)
              const arg = input.prompt.text.trim()
              if (arg.length === 0) {
                yield* notify(
                  deps,
                  input.sessionID,
                  `BanyanCode LSP is ${current ? "on" : "off"}. ${USAGE_LSP}`,
                  "BanyanCode LSP",
                )
                return
              }
              const parsed = switchValue(arg)
              if (parsed === undefined) {
                yield* notify(deps, input.sessionID, `Unknown argument "${arg}". ${USAGE_LSP}`, "BanyanCode LSP")
                return
              }
              const next = parsed === "toggle" ? !current : parsed === "on"
              yield* Effect.promise(() => update(deps.target, { banyancode_lsp: next }))
              yield* notify(
                deps,
                input.sessionID,
                `BanyanCode LSP is now ${next ? "on" : "off"}.`,
                "BanyanCode LSP",
              )
            }).pipe(Effect.asVoid),
        })

        editor.add({
          name: WEBSEARCH_FREE_COMMAND,
          description: WEBSEARCH_FREE_DESCRIPTION,
          execute: (input) =>
            deps.session
              .prompt({
                sessionID: input.sessionID,
                text: [WEBSEARCH_FREE_TEMPLATE, input.prompt.text.trim()].filter(Boolean).join("\n\n"),
              })
              .pipe(Effect.asVoid),
        })

        editor.add({
          name: MAX_SUBAGENTS_COMMAND,
          description: MAX_SUBAGENTS_DESCRIPTION,
          execute: (input) =>
            Effect.gen(function* () {
              const text = input.prompt.text.trim()
              const loaded = yield* deps.config.get()
              const current = loaded.config.banyancode_max_subagents ?? deps.maxSubagentsDefault
              if (text.length === 0) {
                yield* notify(deps, input.sessionID, `Max subagents is ${current}. ${USAGE_MAX}`, "Max subagents")
                return
              }
              const value = Number(text)
              if (!Number.isInteger(value) || value < 1 || value > deps.maxSubagentsLimit) {
                yield* notify(
                  deps,
                  input.sessionID,
                  `Max subagents must be an integer between 1 and ${deps.maxSubagentsLimit}; got "${text}".`,
                  "Max subagents",
                )
                return
              }
              yield* Effect.promise(() => update(deps.target, { banyancode_max_subagents: value }))
              yield* notify(deps, input.sessionID, `Max subagents set to ${value}.`, "Max subagents")
            }).pipe(Effect.asVoid),
        })
      })
      .pipe(Effect.orDie)
  })

export { lspIsOn }

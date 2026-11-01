import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Ref, Result } from "effect"
import { update as updateConfig, type WriteTarget } from "../config/writer.js"
import { runningForRoot } from "./limits.js"
import { lastAssistantText } from "./review.js"
import type { MeshService } from "./service.js"
import type { SessionPort } from "./session-port.js"
import { AGENT } from "./types.js"

/**
 * `/swarm` and `/max-subagents` commands.
 *
 * `/goal` is intentionally NOT registered here: v2's built-in GoalPlugin
 * (`packages/core/src/plugin/goal.ts`) already owns the command and runs the
 * goal-mode stop hook. Re-registering would shadow it.
 */

export const SWARM_COMMAND = "swarm"
export const MAX_SUBAGENTS_COMMAND = "max-subagents"

export type SwarmParse =
  | { readonly mode: "toggle" }
  | { readonly mode: "spawn"; readonly count: number; readonly agent: string; readonly task: string; readonly clamped: boolean }
  | { readonly mode: "error"; readonly error: string; readonly usage: true }

export const SWARM_USAGE =
  "Usage: /swarm <task> [--agents N] [--agent id]  (no arguments toggles swarm mode)"

const USAGE_ERROR = (error: string): SwarmParse => ({ mode: "error", error, usage: true })

/**
 * `/swarm` with arguments spawns N parallel background subagents through
 * `ctx.session.create(parentID) + prompt` with the default wake admission. We do not route it
 * through the orchestrator as a synthetic instruction: direct creation keeps
 * the fan-out deterministic, works when the active agent is not the
 * orchestrator, and each child is a normal v2 subagent session the host can
 * interrupt and notify on.
 */
export const parseSwarmCommand = (
  text: string,
  options: { readonly available: number; readonly defaultAgent?: string },
): SwarmParse => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { mode: "toggle" }
  if (options.available < 1) {
    return USAGE_ERROR("No subagent slots are available right now; wait for a subagent to finish or raise banyancode_max_subagents.")
  }

  const tokens = trimmed.split(/\s+/)
  const taskTokens: string[] = []
  let requested: number | undefined
  let agent = options.defaultAgent ?? AGENT.coder

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token === "--agents" || token === "--agent") {
      const value = tokens[index + 1]
      if (value === undefined) return USAGE_ERROR(`${token} requires a value. ${SWARM_USAGE}`)
      if (token === "--agents") {
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 1) {
          return USAGE_ERROR(`--agents must be a positive integer; got "${value}".`)
        }
        requested = parsed
      } else {
        agent = value
      }
      index += 1
      continue
    }
    if (token.startsWith("--")) return USAGE_ERROR(`Unknown flag ${token}. ${SWARM_USAGE}`)
    taskTokens.push(token)
  }

  const task = taskTokens.join(" ").trim()
  if (task.length === 0) return USAGE_ERROR(`A task is required. ${SWARM_USAGE}`)

  const count = Math.min(requested ?? options.available, options.available)
  return {
    mode: "spawn",
    count,
    agent,
    task,
    clamped: requested !== undefined && requested > options.available,
  }
}

const shardPrompt = (task: string, index: number, count: number): string =>
  [
    "You are a subagent spawned by another session.",
    "",
    task,
    "",
    `Swarm shard ${index + 1}/${count}: work only on your assigned shard, avoid files other shards own, and return the files you changed. Do not commit.`,
  ].join("\n")

const watcher = (deps: {
  readonly sessions: SessionPort
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly index: number
  readonly count: number
}) =>
  Effect.gen(function* () {
    yield* deps.sessions.wait(deps.childSessionID).pipe(Effect.catchCause(() => Effect.void))
    const messages = yield* deps.sessions
      .context(deps.childSessionID)
      .pipe(Effect.catchCause(() => Effect.succeed([])))
    const text = lastAssistantText(messages)
    yield* deps.sessions
      .synthetic({
        sessionID: deps.parentSessionID,
        text: [
          `<swarm_shard id="${deps.childSessionID}" index="${deps.index + 1}" total="${deps.count}" state="completed">`,
          text,
          "</swarm_shard>",
        ].join("\n"),
        description: `Swarm shard ${deps.index + 1} completed`,
      })
      .pipe(Effect.catchCause(() => Effect.void))
  })

const spawnSwarm = (deps: {
  readonly sessions: SessionPort
  readonly sessionID: string
  readonly count: number
  readonly agent: string
  readonly task: string
  readonly callerModel?: { readonly providerID: string; readonly id: string; readonly variant?: string }
  readonly modelForAgent: (agentID: string) => Effect.Effect<
    { readonly providerID: string; readonly id: string; readonly variant?: string } | undefined
  >
}) =>
  Effect.gen(function* () {
    const agentModel = yield* deps.modelForAgent(deps.agent)
    const model = agentModel ?? deps.callerModel
    const outcomes = yield* Effect.forEach(
      Array.from({ length: deps.count }, (_, index) => index),
      (index) =>
        Effect.gen(function* () {
          const child = yield* deps.sessions.create({
            parentID: deps.sessionID,
            title: `Swarm ${index + 1}/${deps.count}: ${deps.task.slice(0, 40)}`,
            agent: deps.agent,
            ...(model === undefined ? {} : { model }),
          })
          // Default wake admission: `resume: false` would only queue the
          // prompt (v2's subagent tool resumes via SubagentJob, which the
          // plugin API does not expose). The default path starts the child.
          yield* deps.sessions.prompt({
            sessionID: child.id,
            text: shardPrompt(deps.task, index, deps.count),
          })
          yield* Effect.forkDetach(
            watcher({
              sessions: deps.sessions,
              parentSessionID: deps.sessionID,
              childSessionID: child.id,
              index,
              count: deps.count,
            }),
          )
          return child.id
        }).pipe(Effect.result),
      { concurrency: 1 },
    )
    const created = outcomes.filter(Result.isSuccess).map((outcome) => outcome.success)
    const failures = outcomes.filter(Result.isFailure).map((outcome) => String(outcome.failure))
    return { created, failures }
  })

/** Same target shape `src/system/index.ts:writeTarget` uses. */
const writeTarget = (ctx: Context): WriteTarget => ({
  directory: ctx.location.directory,
  projectRoot: ctx.location.project.canonical || ctx.location.project.directory,
})

export const registerCommands = (
  ctx: Context,
  deps: { readonly mesh: MeshService; readonly sessions: SessionPort },
): Effect.Effect<void, never, import("effect").Scope.Scope> =>
  Effect.gen(function* () {
    yield* ctx.command.transform((editor) => {
      editor.add({
        name: SWARM_COMMAND,
        description: "toggle swarm mode (no args) or fan out N parallel background subagents",
        execute: (input) =>
          Effect.gen(function* () {
            const text = input.prompt.text.trim()
            const limits = yield* deps.mesh.limits()

            if (text.length === 0) {
              const next = yield* deps.mesh.setSwarmMode(!limits.swarmMode)
              // v1 persisted the toggle in `banyancode.json`. The in-memory
              // flag alone resets on the next plugin activation.
              yield* Effect.promise(() =>
                updateConfig(writeTarget(ctx), { banyancode_swarm_mode: next.swarmMode }),
              ).pipe(
                Effect.catchCause(() =>
                  deps.sessions.synthetic({
                    sessionID: input.sessionID,
                    text: "Swarm mode changed for this session, but writing banyancode.json failed.",
                    description: "Swarm mode",
                  }),
                ),
              )
              yield* deps.sessions.synthetic({
                sessionID: input.sessionID,
                text: `Swarm mode is now ${next.swarmMode ? "on" : "off"}.`,
                description: "Swarm mode",
              })
              return
            }

            if (!limits.backgroundSubagents) {
              yield* deps.sessions.synthetic({
                sessionID: input.sessionID,
                text: "Background subagents are disabled (banyancode_background_subagents=false); /swarm needs them to fan out.",
                description: "Swarm unavailable",
              })
              return
            }

            const map = yield* deps.mesh.snapshotMap()
            const states = yield* Ref.get(deps.mesh.live)
            const running = runningForRoot(map, input.sessionID, states)
            const available = limits.maxSubagents - running
            const parsed = parseSwarmCommand(text, { available, defaultAgent: AGENT.coder })
            if (parsed.mode === "error") {
              yield* deps.sessions.synthetic({
                sessionID: input.sessionID,
                text: parsed.error,
                description: "Swarm input error",
              })
              return
            }
            if (parsed.mode === "toggle") return

            const permitted = yield* ctx.permission
              .assert({
                action: "subagent",
                resources: [parsed.agent],
                save: ["*"],
                metadata: { source: "swarm", count: parsed.count },
                sessionID: input.sessionID,
              })
              .pipe(Effect.as(true), Effect.catchCause(() => Effect.succeed(false)))
            if (!permitted) {
              yield* deps.sessions.synthetic({
                sessionID: input.sessionID,
                text: `Swarm spawn for agent "${parsed.agent}" was denied by permissions.`,
                description: "Swarm denied",
              })
              return
            }

            const caller = yield* deps.sessions.get(input.sessionID)
            const result = yield* spawnSwarm({
              sessions: deps.sessions,
              sessionID: input.sessionID,
              count: parsed.count,
              agent: parsed.agent,
              task: parsed.task,
              ...(caller?.model === undefined ? {} : { callerModel: caller.model }),
              modelForAgent: deps.mesh.modelForAgent,
            })
            const lines = [
              `Swarm spawned ${result.created.length}/${parsed.count} background subagents (agent: ${parsed.agent}, limit: ${limits.maxSubagents}).`,
              ...(parsed.clamped
                ? [`Requested count was clamped to ${parsed.count} to stay under the subagent limit.`]
                : []),
              ...(result.failures.length > 0 ? ["", "Spawn failures:", ...result.failures.map((failure) => `- ${failure}`)] : []),
              "",
              "You will be notified when each shard finishes. Do not poll or duplicate their work.",
            ]
            yield* deps.sessions.synthetic({
              sessionID: input.sessionID,
              text: lines.join("\n"),
              description: "Swarm started",
            })
          }).pipe(Effect.asVoid),
      })

      editor.add({
        name: MAX_SUBAGENTS_COMMAND,
        description: "set max concurrent subagents (1-20); with no arg, prints the current value",
        execute: (input) =>
          Effect.gen(function* () {
            const text = input.prompt.text.trim()
            const limits = yield* deps.mesh.limits()
            if (text.length === 0) {
              yield* deps.sessions.synthetic({
                sessionID: input.sessionID,
                text: `Max subagents is ${limits.maxSubagents}. Usage: /max-subagents <1-20>`,
                description: "Max subagents",
              })
              return
            }
            const parsed = Number(text)
            if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
              yield* deps.sessions.synthetic({
                sessionID: input.sessionID,
                text: `Max subagents must be an integer; got "${text}".`,
                description: "Max subagents",
              })
              return
            }
            const result = yield* deps.mesh.setMaxSubagents(parsed)
            yield* deps.sessions.synthetic({
              sessionID: input.sessionID,
              text: result.ok ? `Max subagents set to ${result.value}.` : result.error,
              description: "Max subagents",
            })
          }).pipe(Effect.asVoid),
      })
    })
  })

/** `/goal` remains v2's GoalPlugin command; warn (not fail) if it is absent. */
export const checkGoalCommand = (ctx: Context) =>
  ctx.command.list().pipe(
    Effect.flatMap((result) =>
      result.data.some((command) => command.name === "goal")
        ? Effect.void
        : Effect.logWarning(
            "mesh: v2 goal command is missing; /goal is owned by the built-in GoalPlugin and was not re-registered",
          ),
    ),
    Effect.catchCause(() => Effect.void),
  )

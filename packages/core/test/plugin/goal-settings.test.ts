import { describe, expect } from "bun:test"
import { DateTime, Duration, Effect, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { Plugin } from "@opencode/plugin/effect"
import type { CommandDefinition } from "@opencode/plugin/effect/command"
import { Goal } from "@opencode/schema/goal"
import { GoalPlugin } from "@opencode/core/plugin/goal"
import { Session } from "@opencode/core/session"
import { it } from "../lib/effect"
import { host } from "./host"

const sessionID = Session.ID.make("ses_goal_settings")

type Review = { sessionID: string; verdict: Goal.Verdict; reason: string }
type Settle = { sessionID: string; status: "complete" | "paused"; reason: string }
type Generated = { sessionID: string; prompt: string; model?: { providerID: string; id: string } }

/**
 * Runs the goal plugin against stubbed domains: storage in memory, scripted
 * reviewer answers, and the idle hook driven by the test instead of the
 * runner. Mirrors `goal-watchdog.test.ts`.
 */
const run = Effect.fnUntraced(function* () {
  const stored = new Map<string, Schema.Json>()
  const changed: unknown[] = []
  const commands: CommandDefinition[] = []
  const hooks: Record<string, ((event: unknown) => Effect.Effect<void>) | undefined> = {}
  const notes: string[] = []
  const generated: Generated[] = []
  const script: string[] = []
  let asked = 0
  const handlers: {
    configure?: (input: Goal.Settings) => Effect.Effect<Goal.Settings>
    review?: (input: Review) => Effect.Effect<Goal.State | null>
    settle?: (input: Settle) => Effect.Effect<Goal.State | null>
    get?: (input: { sessionID: string }) => Effect.Effect<Goal.State | null>
  } = {}

  // SAFETY: the plugin reads only the id, parent, title and creation time of a Session.
  const info = (id: Session.ID) =>
    ({
      id,
      parentID: undefined,
      title: "Release",
      time: { created: DateTime.makeUnsafe(0) },
    }) as unknown as Session.Info

  const session: Partial<Plugin.Context["session"]> = {
    hook: ((name: string, callback: (event: unknown) => Effect.Effect<void>) =>
      Effect.sync(() => {
        hooks[name] = callback
        return { dispose: Effect.void }
      })) as never,
    get: (input) => Effect.succeed(info(input.sessionID)),
    update: () => Effect.void,
    context: () => Effect.succeed([]),
    synthetic: ((input: { text: string }) =>
      Effect.sync(() => {
        notes.push(input.text)
      })) as never,
    generate: ((input: Generated) =>
      Effect.sync(() => {
        generated.push(input)
        asked++
        return { text: script.shift() ?? '{"verdict":"done","reason":"Out of script."}' }
      })) as never,
    command: () => Effect.die("unused session.command"),
    prompt: () => Effect.die("unused session.prompt"),
  }

  yield* GoalPlugin.Plugin.effect(
    host({
      session,
      storage: {
        get: (key) => Effect.sync(() => stored.get(key)),
        set: (key, value) => Effect.sync(() => void stored.set(key, value)),
        remove: (key) => Effect.sync(() => void stored.delete(key)),
        scan: (options) =>
          Effect.sync(() => ({
            entries: [...stored].flatMap(([key, value]) => (key.startsWith(options.prefix) ? [{ key, value }] : [])),
          })),
      },
      rpc: Object.assign(
        () => {
          throw new Error("unused rpc.client")
        },
        {
          // SAFETY: the goal plugin registers one RPC; these tests call its handlers directly.
          register: ((_definition: unknown, registered: typeof handlers) =>
            Effect.sync(() => {
              Object.assign(handlers, registered)
              return {
                dispose: Effect.void,
                events: { emit: (_name: string, data: unknown) => Effect.sync(() => void changed.push(data)) },
              }
            })) as never,
        },
      ),
      // SAFETY: the plugin only filters the stream by event type.
      event: { subscribe: () => Stream.empty as never },
      command: {
        list: () => Effect.die("unused command.list"),
        transform: (callback) =>
          Effect.sync(() => callback({ add: (definition) => void commands.push(definition) })) as never,
        reload: () => Effect.die("unused command.reload"),
      },
    }),
  )
  yield* Effect.yieldNow

  const decode = Schema.decodeUnknownOption(Goal.State)
  const goal = () => Option.getOrUndefined(decode(stored.get(`session:${sessionID}`)))
  const rpc = <A>(name: keyof typeof handlers) => (input: A) =>
    (handlers[name] as ((input: A) => Effect.Effect<unknown>) | undefined)?.(input) ??
    Effect.die(`the goal RPC handler ${name} is missing`)

  return {
    goal,
    changed,
    notes,
    generated,
    asked: () => asked,
    serve: (...replies: ReadonlyArray<string>) => void script.push(...replies),
    configure: (input: Goal.Settings) => rpc<Goal.Settings>("configure")(input) as Effect.Effect<Goal.Settings>,
    review: (input: Omit<Review, "sessionID">) =>
      rpc<Review>("review")({ sessionID, ...input }) as Effect.Effect<Goal.State | null>,
    settle: (input: Omit<Settle, "sessionID">) =>
      rpc<Settle>("settle")({ sessionID, ...input }) as Effect.Effect<Goal.State | null>,
    command: (text: string) =>
      Effect.forEach(commands, (definition) =>
        definition.execute({ sessionID, prompt: { text }, delivery: "steer" }).pipe(Effect.orDie),
      ),
    idle: () => hooks["experimental.idle"]?.({ sessionID, background: [] }) ?? Effect.void,
  }
})

describe("goal settings", () => {
  it.effect("pauses at the configured round budget", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      yield* plugin.configure({ maxRounds: 2 })
      plugin.serve(
        '{"verdict":"continue","reason":"The parser test still fails."}',
        '{"verdict":"continue","reason":"The CLI test still fails."}',
        '{"verdict":"continue","reason":"A third round should not run."}',
      )
      yield* plugin.command("Ship the release")
      // The budget is written into the goal, so a client showing "round x of y" sees the real cap.
      expect(plugin.goal()).toMatchObject({ status: "active", rounds: 0, maxRounds: 2 })

      yield* plugin.idle()
      expect(plugin.goal()).toMatchObject({ status: "active", rounds: 1 })
      yield* plugin.idle()
      expect(plugin.goal()).toMatchObject({ status: "active", rounds: 2 })
      yield* plugin.idle()

      expect(plugin.asked()).toBe(2)
      expect(plugin.goal()).toMatchObject({ status: "paused", reason: "Reached the limit of 2 rounds" })
    }),
  )

  it.effect("keeps the stock 50-round budget while the key is unset", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      plugin.serve(...Array<string>(3).fill('{"verdict":"continue","reason":"Not yet."}'))
      yield* plugin.command("Ship the release")
      expect(plugin.goal()).toMatchObject({ maxRounds: GoalPlugin.MAX_ROUNDS })
      yield* plugin.idle()
      expect(plugin.goal()).toMatchObject({ status: "active", rounds: 1 })
    }),
  )

  it.effect("pauses when the goal exceeds its time budget, without asking the reviewer", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      yield* plugin.configure({ maxTimeMs: 60_000 })
      plugin.serve('{"verdict":"continue","reason":"Still going."}')
      yield* plugin.command("Ship the release")
      yield* TestClock.adjust(Duration.millis(59_000))
      yield* plugin.idle()
      // Inside the budget: the loop continues as usual.
      expect(plugin.asked()).toBe(1)
      expect(plugin.goal()).toMatchObject({ status: "active" })
      yield* TestClock.adjust(Duration.millis(1_000))
      yield* plugin.idle()

      expect(plugin.asked()).toBe(1)
      expect(plugin.goal()).toMatchObject({ status: "paused" })
      expect(plugin.goal()?.reason).toContain("Reached the goal time limit")
    }),
  )

  it.effect("retries a blocked verdict on the round budget while auto-retry is on", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      yield* plugin.configure({ autoRetryOnBlock: true, maxRounds: 2 })
      plugin.serve(
        '{"verdict":"blocked","reason":"Waiting on the staging deploy."}',
        '{"verdict":"blocked","reason":"Waiting on the staging deploy."}',
      )
      yield* plugin.command("Ship the release")

      // v1 retried blocked verdicts until the iteration cap, even with an unchanged reason.
      yield* plugin.idle()
      expect(plugin.goal()).toMatchObject({ status: "active", rounds: 1, reason: "Waiting on the staging deploy." })
      yield* plugin.idle()
      expect(plugin.goal()).toMatchObject({ status: "active", rounds: 2, reason: "Waiting on the staging deploy." })
      yield* plugin.idle()

      expect(plugin.asked()).toBe(2)
      expect(plugin.goal()).toMatchObject({ status: "paused", reason: "Reached the limit of 2 rounds" })
    }),
  )

  it.effect("surfaces a blocked verdict unchanged while auto-retry is unset or off", () =>
    Effect.gen(function* () {
      for (const settings of [{ maxRounds: 2 }, { maxRounds: 2, autoRetryOnBlock: false }]) {
        const plugin = yield* run()
        yield* plugin.configure(settings)
        plugin.serve('{"verdict":"blocked","reason":"Waiting on the staging deploy."}')
        yield* plugin.command("Ship the release")
        yield* plugin.idle()

        expect(plugin.asked()).toBe(1)
        expect(plugin.goal()).toMatchObject({ status: "paused", reason: "Waiting on the staging deploy." })
      }
    }),
  )

  it.effect("asks the reviewer with the configured evaluator model", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      yield* plugin.configure({ evaluatorModel: "cheap/fast" })
      plugin.serve('{"verdict":"done","reason":"All tests pass."}')
      yield* plugin.command("Ship the release")
      yield* plugin.idle()

      expect(plugin.generated).toMatchObject([{ model: { providerID: "cheap", id: "fast" } }])
      expect(plugin.goal()).toMatchObject({ status: "complete" })
    }),
  )

  it.effect("asks with the Session's model while the evaluator model is unset", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      plugin.serve('{"verdict":"done","reason":"All tests pass."}')
      yield* plugin.command("Ship the release")
      yield* plugin.idle()

      expect(plugin.generated).toHaveLength(1)
      expect(plugin.generated[0]).not.toHaveProperty("model")
    }),
  )

  it.effect("counts a recorded review as a round and stops at the budget", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      yield* plugin.configure({ maxRounds: 2 })
      yield* plugin.command("Ship the release")

      expect(yield* plugin.review({ verdict: "fail", reason: "the parser test fails" })).toMatchObject({
        status: "active",
        rounds: 1,
        reason: "the parser test fails",
      })
      // A pass never triggers the cap: the orchestrator decides when to complete the goal.
      expect(yield* plugin.review({ verdict: "pass", reason: "everything passes" })).toMatchObject({
        status: "active",
        rounds: 2,
      })
      expect(yield* plugin.review({ verdict: "fail", reason: "a later change broke it" })).toMatchObject({
        status: "paused",
        reason: "max iterations reached",
      })
    }),
  )

  it.effect("completes and blocks the goal over RPC and ignores later changes", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      yield* plugin.command("Ship the release")

      expect(yield* plugin.settle({ status: "complete", reason: "All 12 tests pass." })).toMatchObject({
        status: "complete",
        reason: "All 12 tests pass.",
      })
      expect(yield* plugin.review({ verdict: "fail", reason: "late" })).toMatchObject({
        status: "complete",
        reason: "All 12 tests pass.",
      })
      expect(yield* plugin.settle({ status: "paused", reason: "Stopped." })).toMatchObject({ status: "complete" })
    }),
  )

  it.effect("blocks by pausing with the reason, because v2 has no blocked status", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      yield* plugin.command("Ship the release")
      expect(yield* plugin.settle({ status: "paused", reason: "Waiting on the user." })).toMatchObject({
        status: "paused",
        reason: "Waiting on the user.",
      })
      // Resume still works, which is the user-visible equivalent of v1's blocked goal being resumable.
      yield* plugin.command("resume")
      expect(plugin.goal()).toMatchObject({ status: "active", rounds: 1 })
    }),
  )
})

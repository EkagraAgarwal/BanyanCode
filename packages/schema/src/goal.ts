export * as Goal from "./goal.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

export const Status = Schema.Literals(["active", "paused", "complete"])
export type Status = typeof Status.Type

export interface State extends Schema.Schema.Type<typeof State> {}
export const State = Schema.Struct({
  id: Schema.String,
  objective: Schema.String,
  status: Status,
  /** Why the goal last changed: the reviewer's reason, or what paused it. */
  reason: optional(Schema.String),
  /** Continuations sent since the goal was set or last resumed. */
  rounds: Schema.Number,
  /** A backstop for loops that stall detection misses. */
  maxRounds: Schema.Number,
  /** Rounds in a row without progress: no tool calls, or the same reason as the round before. */
  stalls: optional(Schema.Number),
  /** The server process that armed the goal. */
  boot: Schema.String,
  updatedAt: Schema.Number,
}).annotate({ identifier: "Goal.State" })

/** The reviewer verdict the orchestrator records with the `goal` tool's `record_review` action. */
export const Verdict = Schema.Literals(["pass", "fail", "blocked"])
export type Verdict = typeof Verdict.Type

/**
 * How BanyanCode tunes the loop from `banyancode.json`. Every field is optional: an unset field keeps the plugin's
 * stock behavior, and `configure` replaces the whole set (an omitted field clears a previous override).
 */
export interface Settings extends Schema.Schema.Type<typeof Settings> {}
export const Settings = Schema.Struct({
  /** Reviewer-fail iterations before the loop pauses. v1: `banyancode_max_goal_iterations`. */
  maxRounds: optional(Schema.Number),
  /** Wall-clock budget for one goal run in milliseconds; `0` removes the cap. v1: `banyancode_goal_max_time_ms`. */
  maxTimeMs: optional(Schema.Number),
  /** Retry the loop on the reviewer's `blocked` verdict instead of pausing. v1: `banyancode_goal_auto_retry_on_block`. */
  autoRetryOnBlock: optional(Schema.Boolean),
  /** Model the reviewer asks, as `"provider/model"`. v1: `banyancode_goal_evaluator_model`. */
  evaluatorModel: optional(Schema.String),
}).annotate({ identifier: "Goal.Settings" })

/**
 * The `/goal` plugin's RPC. Clients read a Session's goal with `get` and keep it current from `changed`, which the
 * plugin publishes in the Session's Location on every write. A Session's goal is its own: children and forks start
 * without one. The schemas are Standard Schemas too, so Promise clients can call it.
 *
 * `configure`, `review` and `settle` are the BanyanCode seams: `configure` applies `banyancode.json` tuning,
 * `review` records the `goal` tool's `record_review` verdict (counting one round), and `settle` lets the orchestrator
 * end the loop with `complete` or `block`. They are additive; clients that only use `get` and `changed` are unaffected.
 */
export const Definition = Rpc.define({
  id: "opencode.goal",
  methods: {
    get: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.NullOr(State)),
    },
    configure: {
      input: Schema.toStandardSchemaV1(Settings),
      output: Schema.toStandardSchemaV1(Settings),
    },
    review: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({ sessionID: Schema.String, verdict: Verdict, reason: Schema.String }),
      ),
      output: Schema.toStandardSchemaV1(Schema.NullOr(State)),
    },
    settle: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: Schema.String,
          status: Schema.Literals(["complete", "paused"]),
          reason: Schema.String,
        }),
      ),
      output: Schema.toStandardSchemaV1(Schema.NullOr(State)),
    },
  },
  events: {
    changed: {
      schema: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String, goal: Schema.NullOr(State) })),
    },
  },
})

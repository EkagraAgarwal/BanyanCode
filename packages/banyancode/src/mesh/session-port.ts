import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Option } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { snapshotFromInfo } from "./status.js"
import type { MeshSessionSnapshot } from "./types.js"

/** Host-neutral seam over `ctx.session`, so mesh logic is testable without a live host. */
export interface SessionPort {
  readonly list: (limit?: number) => Effect.Effect<readonly MeshSessionSnapshot[]>
  readonly get: (sessionID: string) => Effect.Effect<MeshSessionSnapshot | undefined>
  readonly create: (input: {
    readonly parentID: string
    readonly title: string
    readonly agent: string
    readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string }
  }) => Effect.Effect<{ readonly id: string }>
  readonly prompt: (input: {
    readonly sessionID: string
    readonly text: string
    readonly delivery?: "steer" | "queue"
    readonly resume?: boolean
  }) => Effect.Effect<void>
  readonly wait: (sessionID: string) => Effect.Effect<void>
  readonly synthetic: (input: {
    readonly sessionID: string
    readonly text: string
    readonly description?: string
    readonly metadata?: Record<string, unknown>
  }) => Effect.Effect<void>
  readonly interrupt: (sessionID: string) => Effect.Effect<boolean>
  readonly context: (sessionID: string) => Effect.Effect<readonly SessionMessage.Info[]>
}

const sid = (value: string): Session.ID => value as Session.ID

export const pluginSessionPort = (sessions: Context["session"]): SessionPort => {
  const list: SessionPort["list"] = (limit = 200) =>
    sessions.list({ limit }).pipe(Effect.map((result) => result.data.map(snapshotFromInfo)), Effect.orDie)

  const get: SessionPort["get"] = (sessionID) =>
    sessions
      .get({ sessionID: sid(sessionID) })
      .pipe(
        Effect.option,
        Effect.map((result) => (Option.isNone(result) ? undefined : snapshotFromInfo(result.value))),
        Effect.orDie,
      )

  const create: SessionPort["create"] = (input) =>
    sessions
      .create({
        parentID: sid(input.parentID),
        title: input.title,
        agent: input.agent as never,
        ...(input.model === undefined
          ? {}
          : {
              model: {
                providerID: input.model.providerID as never,
                id: input.model.id as never,
                ...(input.model.variant === undefined ? {} : { variant: input.model.variant as never }),
              },
            }),
      })
      .pipe(Effect.map((info) => ({ id: info.id })), Effect.orDie)

  const prompt: SessionPort["prompt"] = (input) =>
    sessions
      .prompt({
        sessionID: sid(input.sessionID),
        text: input.text,
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
        ...(input.resume === undefined ? {} : { resume: input.resume }),
      })
      .pipe(Effect.asVoid, Effect.orDie)

  const wait: SessionPort["wait"] = (sessionID) => sessions.wait({ sessionID: sid(sessionID) }).pipe(Effect.orDie)

  const synthetic: SessionPort["synthetic"] = (input) =>
    sessions
      .synthetic({
        sessionID: sid(input.sessionID),
        text: input.text,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      })
      .pipe(Effect.asVoid, Effect.orDie)

  const interrupt: SessionPort["interrupt"] = (sessionID) =>
    sessions.interrupt({ sessionID: sid(sessionID) }).pipe(Effect.map((result) => result.interrupted), Effect.orDie)

  const context: SessionPort["context"] = (sessionID) => sessions.context({ sessionID: sid(sessionID) }).pipe(Effect.orDie)

  return { list, get, create, prompt, wait, synthetic, interrupt, context }
}

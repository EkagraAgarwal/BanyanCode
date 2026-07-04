import { Effect, Layer } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Permission } from "@/permission"

const toAskInput = (input: PermissionV2.AssertInput): PermissionV1.AskInput =>
  ({
    id: input.id as unknown as PermissionV1.ID,
    sessionID: input.sessionID as unknown as PermissionV1.Request["sessionID"],
    permission: input.action,
    patterns: [...input.resources],
    always: input.save?.includes("*") ? [...input.resources] : [],
    metadata: (input.metadata ?? {}) as Record<string, unknown>,
    tool:
      input.source?.type === "tool"
        ? { messageID: input.source.messageID, callID: input.source.callID }
        : undefined,
    ruleset: [],
  }) as PermissionV1.AskInput

const requestToV2 = (request: PermissionV1.Request): PermissionV2.Request =>
  ({
    id: request.id as unknown as PermissionV2.ID,
    sessionID: request.sessionID as unknown as PermissionV2.Request["sessionID"],
    action: request.permission,
    resources: [...request.patterns],
    save: [...request.always],
    metadata: { ...request.metadata },
    source: request.tool
      ? { type: "tool", messageID: request.tool.messageID, callID: request.tool.callID }
      : undefined,
  }) as PermissionV2.Request

const mapV1Error = (error: PermissionV1.Error): PermissionV2.Error => {
  switch (error._tag) {
    case "PermissionDeniedError":
      return new PermissionV2.DeniedError({
        rules: (error as PermissionV1.DeniedError).ruleset as unknown as PermissionV2.DeniedError["rules"],
      })
    case "PermissionCorrectedError":
      return new PermissionV2.CorrectedError({ feedback: (error as PermissionV1.CorrectedError).feedback })
    case "PermissionRejectedError":
      return new PermissionV2.RejectedError({})
  }
}

type BridgeMethods = {
  readonly ask: (input: PermissionV2.AssertInput) => Effect.Effect<PermissionV2.AskResult, never, never>
  readonly assert: (input: PermissionV2.AssertInput) => Effect.Effect<void, PermissionV2.Error, never>
  readonly reply: (input: PermissionV2.ReplyInput) => Effect.Effect<void, PermissionV2.NotFoundError, never>
  readonly get: (id: PermissionV2.ID) => Effect.Effect<PermissionV2.Request | undefined, never, never>
  readonly forSession: (
    sessionID: PermissionV2.Request["sessionID"],
  ) => Effect.Effect<ReadonlyArray<PermissionV2.Request>, never, never>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV2.Request>, never, never>
}

export const bridge = Layer.effect(
  PermissionV2.Service,
  Effect.gen(function* () {
    const v1 = yield* Permission.Service

    const assert = Effect.fn("PermissionBridge.assert")(function* (input: PermissionV2.AssertInput) {
      yield* v1.ask(toAskInput(input)).pipe(
        Effect.mapError((error) => mapV1Error(error as PermissionV1.Error) as never),
      )
    })

    const ask = Effect.fn("PermissionBridge.ask")(function* (input: PermissionV2.AssertInput) {
      const id = PermissionV2.ID.create() as unknown as PermissionV2.ID
      const outcome = yield* Effect.catchCause(
        v1.ask(toAskInput({ ...input, id: id as unknown as PermissionV2.AssertInput["id"] })).pipe(
          Effect.mapError((error) => mapV1Error(error as PermissionV1.Error) as never),
        ),
        () => Effect.succeed(undefined),
      )
      void outcome
      return { id, effect: "ask" as const } satisfies PermissionV2.AskResult
    })

    const reply = Effect.fn("PermissionBridge.reply")(function* (input: PermissionV2.ReplyInput) {
      yield* v1
        .reply({
          requestID: input.requestID as unknown as PermissionV1.ID,
          reply: input.reply,
          message: input.message,
        })
        .pipe(Effect.mapError(() => new PermissionV2.NotFoundError({ requestID: input.requestID })))
    })

    const get = Effect.fn("PermissionBridge.get")(function* (id: PermissionV2.ID) {
      const items = yield* v1.list()
      const found = items.find((item) => String(item.id) === String(id))
      return found ? requestToV2(found) : undefined
    })

    const forSession = Effect.fn("PermissionBridge.forSession")(function* (
      sessionID: PermissionV2.Request["sessionID"],
    ) {
      const items = yield* v1.list()
      const sid = String(sessionID)
      return items.filter((item) => String(item.sessionID) === sid).map(requestToV2)
    })

    const list = Effect.fn("PermissionBridge.list")(function* () {
      const items = yield* v1.list()
      return items.map(requestToV2)
    })

    return { assert, ask, reply, get, forSession, list } satisfies BridgeMethods as never
  }),
)

export const layer: Layer.Layer<PermissionV2.Service, never, Permission.Service> = bridge

export const PermissionBridge = { layer }

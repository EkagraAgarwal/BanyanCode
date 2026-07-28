export * as MeshSubscribeTool from "./mesh-subscribe"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema, Stream } from "effect"
import { MeshCoordinator } from "../banyancode/mesh-coordinator"
import { SubagentBus } from "../banyancode/subagent-bus"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

/** Default wait for the initial batch of messages before returning empty. */
const DEFAULT_TIMEOUT_MS = 30_000

export const name = "mesh_subscribe"

const SubagentMessageSchema = Schema.Struct({
  id: Schema.String,
  parentSessionID: Schema.String,
  fromSession: Schema.String,
  fromAgent: Schema.String,
  toSession: Schema.optional(Schema.String),
  toAgent: Schema.optional(Schema.String),
  kind: Schema.Literals([
    "request",
    "inform",
    "answer",
    "poll",
    "steer",
    "checkpoint",
    "plan",
    "plan_update",
    "kill",
    "review",
  ]),
  payload: Schema.Unknown,
  deliveredAt: Schema.optional(Schema.Number),
  createdAt: Schema.Number,
})

export const Input = Schema.Struct({
  parentSessionID: Schema.String,
  agentName: Schema.optional(Schema.String),
  maxMessages: Schema.optional(Schema.Number),
  /**
   * Maximum time (milliseconds) to wait for `maxMessages` messages before
   * returning whatever is in the buffer. Defaults to 30s. The safety net
   * prevents indefinite hangs on a quiet-but-valid session; the primary
   * fix for an invalid parentSessionID is the upstream `SubagentSessionNotFoundError`
   * which fires immediately on a session that does not exist.
   */
  timeoutMs: Schema.optional(Schema.Number),
})

export const Output = Schema.Struct({
  messages: Schema.Array(SubagentMessageSchema),
  streamActive: Schema.Boolean,
})

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const coordinator = yield* MeshCoordinator.Service

    yield* tools.register({
      [name]: Tool.make({
        description:
          "Subscribe to peer subagent activity for this parent session. " +
          "Returns the first N messages as an initial batch; the stream " +
          "remains active for the session lifetime. Use this in place of " +
          "polling mesh_control.status to wait for specific subagent results. " +
          "If the parent session does not exist, the tool fails fast with a " +
          "ToolFailure rather than blocking indefinitely.",
        input: Input,
         contract: { visibility: "public" },
        output: Output,
        toModelOutput: ({ output }) => [
          { type: "text", text: `messages=${output.messages.length} streamActive=${output.streamActive}` },
        ],
        execute: (input, context) => {
          return Effect.gen(function* () {
            yield* permission.assert({
              action: name,
              resources: [input.parentSessionID],
              save: ["*"],
              metadata: input,
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            const stream = yield* coordinator.subscribe({
              parentSessionID: input.parentSessionID as any,
              agentName: input.agentName,
            })
            const maxMessages = input.maxMessages ?? 10
            const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
            const messages = yield* stream
              .pipe(Stream.take(maxMessages), Stream.runCollect)
              .pipe(
                Effect.timeoutOrElse({
                  duration: `${timeoutMs} millis`,
                  orElse: () => Effect.succeed([] as ReadonlyArray<unknown>),
                }),
              )
            return { messages: [...messages] as never, streamActive: true }
          }).pipe(
            // Translate only the typed SubagentSessionNotFoundError to a
            // ToolFailure so the model sees a clear error and the test
            // suite can assert on it. Other unexpected errors are wrapped
            // with the generic ToolFailure for the same reason.
            Effect.catchTag("Banyan/SubagentSessionNotFoundError", (e) =>
              Effect.fail(
                new ToolFailure({
                  message: `mesh_subscribe: parent session ${e.parentSessionID} not found`,
                }),
              ),
            ),
            Effect.mapError((e) =>
              e instanceof ToolFailure
                ? e
                : new ToolFailure({ message: `mesh_subscribe failed` }),
            ),
          )
        },
      }),
    })
  }),
)

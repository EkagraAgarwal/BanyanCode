export * as MeshSubscribeTool from "./mesh-subscribe"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
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
  /**
   * True when the wait timed out (no messages arrived in `timeoutMs`).
   * Optional for backward compatibility with callers that pre-date
   * the timeout-path fix; new callers should always inspect this.
   */
  timedOut: Schema.optional(Schema.Boolean),
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
          return Effect.scoped(
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.parentSessionID],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              // coordinator.subscribe returns { queue, stream } so the tool
              // can register queue cleanup in this scoped block. The previous
              // implementation relied on the coordinator's internal
              // Effect.scoped, which closed the scope on return and shut the
              // queue before any consumer could read it.
              const { queue, stream } = yield* coordinator.subscribe({
                parentSessionID: input.parentSessionID as any,
                agentName: input.agentName,
              })
              yield* Effect.addFinalizer(() => Queue.shutdown(queue))
              const maxMessages = input.maxMessages ?? 10
              const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

              // Race the take-N-collect against a deadline. Pre-fix we
              // used Effect.timeoutOrElse which returns the orElse value
              // when the timer fires but leaves the inner
              // Stream.take(N).runCollect fiber running until the
              // surrounding scope closes — a leak every time the
              // consumer timed out. Effect.race interleaves the two
              // fibers and INTERRUPTS the loser when the winner
              // completes, so the empty queue path cancels its own
              // subscription. The CC-001 addFinalizer still shuts the
              // queue as this scoped block exits.
              const collect = stream
                .pipe(Stream.take(maxMessages), Stream.runCollect)
                .pipe(
                  Effect.map((chunk) => ({
                    timedOut: false,
                    messages: Array.from(chunk) as ReadonlyArray<unknown>,
                  })),
                )
              const deadline = Effect.sleep(`${timeoutMs} millis`).pipe(
                Effect.map(() => ({
                  timedOut: true,
                  messages: [] as ReadonlyArray<unknown>,
                })),
              )
              const result = yield* collect.pipe(Effect.race(deadline))
              return {
                messages: [...result.messages] as never,
                streamActive: !result.timedOut,
                timedOut: result.timedOut,
              }
            }),
          ).pipe(
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

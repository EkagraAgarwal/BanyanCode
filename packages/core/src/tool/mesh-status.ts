export * as MeshStatusTool from "./mesh-status"

import { Effect, Layer, Option, Schema } from "effect"
import { Banyan } from "../banyancode"
import { traced } from "../observability/trace"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "mesh_status"

// `Schema.Struct({})` projects to `{ anyOf: [{type:"object"}, {type:"array"}] }`,
// which strict tool-schema validators (OpenAI Responses, GPT-5 family, etc.)
// reject. `Schema.Record(Schema.String, Schema.Unknown)` projects to a bare
// `{ type: "object" }`; see system-status.ts for the same fix.
export const Input = Schema.Record(Schema.String, Schema.Unknown).annotate({
  description:
    "Report the subagent mesh state for the current orchestration tree: " +
    "peer agents and their statuses, plus recent peer activity. Read-only " +
    "diagnostic; returns an empty shape when no mesh coordinator is active.",
})

const AgentStatusSchema = Schema.Struct({
  agent: Schema.String,
  status: Schema.String,
})

const RecentActivitySchema = Schema.Struct({
  at: Schema.Number,
  from: Schema.String,
})

export const Output = Schema.Struct({
  agents: Schema.Array(AgentStatusSchema),
  recentActivity: Schema.Array(RecentActivitySchema),
})

const EMPTY = { agents: [], recentActivity: [] }

const renderOutput = (output: Schema.Schema.Type<typeof Output>): string => {
  const agentLines = output.agents
    .map((peer) => `  ${peer.agent} (${peer.status})`)
    .join("\n")
  const activityLines = output.recentActivity
    .map((activity) => `  ${activity.from} @ ${activity.at}`)
    .join("\n")
  return [
    `agents=${output.agents.length} recentActivity=${output.recentActivity.length}`,
    output.agents.length > 0 ? `Agents:\n${agentLines}` : "Agents: none.",
    output.recentActivity.length > 0 ? `Recent activity:\n${activityLines}` : "Recent activity: none.",
  ].join("\n")
}

export const makeMeshStatusTool = (deps: { readonly permission: PermissionV2.Interface }) =>
  Tool.make({
    description:
      "Use when:\n" +
      "  you need a snapshot of the subagent mesh: which peer agents are " +
      "  active/idle/disconnected for the current orchestration tree and what " +
      "  recent peer activity looks like.\n" +
      "Examples\n" +
      "  - \"What's the state of the mesh?\"\n" +
      "  - \"Are any subagents still running?\"\n" +
      "Returns\n" +
      "  { agents: [{ agent, status }], recentActivity: [{ at, from }] }\n" +
      "Avoid when\n" +
      "  you need to control subagents — use mesh_control.\n" +
      "Note\n" +
      "  Read-only diagnostic. Never fails: returns an empty shape when no " +
      "  coordinator is active or the status read hiccups.",
    contract: { visibility: "public" },
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [
      { type: "text", text: `agents=${output.agents.length} recentActivity=${output.recentActivity.length}` },
    ],
    execute: (input, context) => {
      return traced(
        process.cwd(),
        context.sessionID,
        name,
        input,
        (output) => `agents=${output.agents.length} recentActivity=${output.recentActivity.length}`,
        Effect.gen(function* () {
          yield* deps.permission.assert({
            action: name,
            resources: ["*"],
            save: ["*"],
            metadata: {},
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
          }).pipe(Effect.orDie)

          const coordinatorOption = yield* Effect.serviceOption(Banyan.MeshCoordinator)
          if (Option.isNone(coordinatorOption)) return EMPTY
          const coordinator = coordinatorOption.value

          const parents = yield* coordinator.listTrackedParents()
          if (parents.length === 0) return EMPTY
          // Prefer the current session when it is a tracked parent; otherwise
          // fall back to the most recently tracked orchestration tree.
          const parentID = parents.includes(context.sessionID)
            ? context.sessionID
            : parents[parents.length - 1]
          const status = yield* coordinator.status(parentID)
          return {
            agents: status.peers.map((peer) => ({ agent: peer.agent, status: peer.status })),
            recentActivity: status.recentActivity.map((activity) => ({ at: activity.at, from: activity.from })),
          }
        }).pipe(
          // Diagnostic tool: never fail — any coordinator/DB hiccup yields the
          // empty shape instead of surfacing an error.
          Effect.catchCause(() => Effect.succeed(EMPTY)),
        ),
      )
    },
  })

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    // MeshCoordinator is read via serviceOption inside execute, so the layer
    // only needs Tools + PermissionV2; the coordinator may be absent.
    yield* tools.register({ [name]: makeMeshStatusTool({ permission }) })
  }),
)

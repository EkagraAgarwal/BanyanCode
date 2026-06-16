export * as CodegraphStatusTools from "./codegraph-status"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name_status = "codegraph_status"

export const InputStatus = Schema.Struct({
  root: Schema.String.pipe(Schema.optional),
})

export const OutputStatus = Schema.Struct({
  roots: Schema.Array(Schema.Struct({
    id: Schema.String,
    rootPath: Schema.String,
    lastBuildAt: Schema.NullOr(Schema.Number),
    indexedFileCount: Schema.Number,
    nodeCount: Schema.Number,
    edgeCount: Schema.Number,
    embeddingModel: Schema.NullOr(Schema.String),
    parserVersion: Schema.String,
    createdAt: Schema.Number,
  })),
  activeJob: Schema.NullOr(Schema.Struct({
    state: Schema.String,
    root: Schema.NullOr(Schema.String),
    done: Schema.Number,
    total: Schema.Number,
    currentFile: Schema.NullOr(Schema.String),
  })),
})

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE === "1"

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const repo = yield* Banyan.CodegraphRepo
    const buildService = yield* Banyan.CodegraphBuildService

    yield* tools.register({
      [name_status]: Tool.make({
        description: "Get the current status of the code graph: indexed roots, file counts, node counts, edge counts, embedding model, and any active build job.",
        input: InputStatus,
        output: OutputStatus,
        toModelOutput: ({ output }) => [
          { type: "text", text: `codegraph: ${output.roots.length} root(s), ${output.roots.reduce((s, r) => s + r.indexedFileCount, 0)} files indexed${output.activeJob ? `, active job: ${output.activeJob.state} (${output.activeJob.done}/${output.activeJob.total})` : ""}` },
        ],
        execute: (input, context) => {
          return Effect.gen(function* () {
            yield* permission.assert({
              action: name_status,
              resources: [input.root ?? "*"],
              save: ["*"],
              metadata: input,
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })

            const allRoots = yield* repo.listRoots()
            const filteredRoots = input.root
              ? allRoots.filter((r) => r.rootPath === input.root || r.id === input.root)
              : allRoots

            let activeJob: { state: string; root: string | null; done: number; total: number; currentFile: string | null } | null = null
            const buildState = yield* buildService.status()
            if (buildState.status === "running") {
              activeJob = {
                state: buildState.status,
                root: buildState.root ?? null,
                done: buildState.done,
                total: buildState.total,
                currentFile: buildState.currentFile ?? null,
              }
            }

            return {
              roots: filteredRoots.map((r) => ({
                id: r.id,
                rootPath: r.rootPath,
                lastBuildAt: r.lastBuildAt,
                indexedFileCount: r.indexedFileCount,
                nodeCount: r.nodeCount,
                edgeCount: r.edgeCount,
                embeddingModel: r.embeddingModel,
                parserVersion: r.parserVersion,
                createdAt: r.createdAt,
              })),
              activeJob,
            }
          }).pipe(Effect.mapError(() => new ToolFailure({ message: "codegraph_status failed" })))
        },
      }),
    }).pipe(Effect.orDie)
  }),
)

export * as MemoryStatsTool from "./memory-stats"

import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { traced } from "../observability/trace"
import type { Interface as MemoryRepoInterface } from "../banyancode/memory-repo"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "memory_stats"

// Mirrors MAX_TOTAL_STORAGE_BYTES in tool/memory.ts. Duplicated here (not
// imported) to keep the diagnostic tool decoupled from the store tools; keep
// in sync if the quota ever changes.
const QUOTA_BYTES = 100 * 1024 * 1024

export const Input = Schema.Struct({}).annotate({
  description:
    "Report cross-session memory usage: entry counts and approximate stored " +
    "bytes for global and session scopes, compared against the storage quota.",
})

const ScopeStatsSchema = Schema.Struct({
  entries: Schema.Int,
  bytes: Schema.Int,
})

export const Output = Schema.Struct({
  global: ScopeStatsSchema,
  session: ScopeStatsSchema,
  totalBytes: Schema.Int,
  quotaBytes: Schema.Int,
})

const bytesOf = (entries: ReadonlyArray<{ value: unknown }>): number =>
  entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.value)), 0)

const renderOutput = (output: Schema.Schema.Type<typeof Output>): string => {
  const pct = output.quotaBytes === 0 ? 0 : Math.round((output.totalBytes / output.quotaBytes) * 100)
  return [
    `global entries=${output.global.entries} bytes=${output.global.bytes}`,
    `session entries=${output.session.entries} bytes=${output.session.bytes}`,
    `total=${output.totalBytes} / ${output.quotaBytes} bytes (${pct}%)`,
  ].join("\n")
}

export const makeMemoryStatsTool = (deps: {
  readonly permission: PermissionV2.Interface
  readonly repo: MemoryRepoInterface
}) =>
  Tool.make({
    description:
      "Use when:\n" +
      "  you need a quick accounting of cross-session memory usage: entry " +
      "  counts and stored bytes for the global and session scopes, plus how " +
      "  close the total is to the storage quota.\n" +
      "Examples\n" +
      "  - \"How much memory is stored?\"\n" +
      "  - \"Are we near the memory quota?\"\n" +
      "Returns\n" +
      "  { global: { entries, bytes }, session: { entries, bytes }, totalBytes, quotaBytes }\n" +
      "Avoid when\n" +
      "  you need to read or write entries — use memory_recall / memory_store.",
    contract: { visibility: "public" },
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [{ type: "text", text: renderOutput(output) }],
    execute: (input, context) => {
      return traced(
        process.cwd(),
        context.sessionID,
        name,
        input,
        (output) => `global=${output.global.entries} session=${output.session.entries} total=${output.totalBytes}B`,
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

          const [globalEntries, sessionEntries] = yield* Effect.all([
            deps.repo.list("global"),
            // Blank session id = session-scoped rows written without a
            // resolved session id (orphan/legacy rows); the repo API has no
            // "all sessions" mode, so this is the session-wide signal.
            deps.repo.list("session", undefined),
          ])
          const globalBytes = bytesOf(globalEntries)
          const sessionBytes = bytesOf(sessionEntries)
          return {
            global: { entries: globalEntries.length, bytes: globalBytes },
            session: { entries: sessionEntries.length, bytes: sessionBytes },
            totalBytes: globalBytes + sessionBytes,
            quotaBytes: QUOTA_BYTES,
          }
        }),
      )
    },
  })

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const repo = yield* Banyan.MemoryRepo

    yield* tools.register({
      [name]: makeMemoryStatsTool({
        permission,
        repo: repo as unknown as Parameters<typeof makeMemoryStatsTool>[0]["repo"],
      }),
    })
  }),
)

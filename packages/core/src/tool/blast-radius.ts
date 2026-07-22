export * as BlastRadiusTool from "./blast-radius"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import type { Interface as CodegraphRepoInterface } from "../banyancode/codegraph-repo"
import type { Interface as CodegraphAnalyzerInterface } from "../banyancode/codegraph-analyzer"
import type { Interface as PermissionV2Interface } from "../permission"
import { Banyan, isStale } from "../banyancode"
import { resolveGraphTargetPure } from "../banyancode/symbol-resolver"
import { traced } from "../observability/trace"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { defaultLayer as codegraphAnalyzerLayer } from "../banyancode/codegraph-analyzer"
import { optionalNumber } from "./tool-schema"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "blast_radius"

export const Input = Schema.Struct({
  target: Schema.String.annotate({
    description:
      "REQUIRED. The symbol name (e.g. 'MemoryRepo.update') or node ID " +
      "(UUID:line-line) to measure blast radius for. Pass the same value " +
      "you would pass to code_find intent='definition'.",
  }),
  maxDepth: optionalNumber.annotate({
    description:
      "Maximum traversal depth for transitive callers. Defaults to 64 when " +
      "omitted (capped at the BFS_MAX constant inside the tool). " +
      "Pass a smaller value (e.g. 3) for a shallow radius.",
  }),
}).annotate({
  description:
    "Count-only blast radius for a symbol: how many direct callers, " +
    "transitive callers, files, and tests would be affected by a change. " +
    "Returns counts only — for full candidate lists and risk tags, use preflight.",
})

export const Output = Schema.Struct({
  directCallers: Schema.Number,
  transitiveCallers: Schema.Number,
  filesAffected: Schema.Number,
  testsToRun: Schema.Number,
  risk: Schema.Literals(["low", "medium", "high"]),
  graphStale: Schema.optional(Schema.Boolean),
})

const BFS_MAX = 64
const TEST_PATH = /\.(test|spec)\.[^.]+$|(^|\/)__tests__\//

const score = (dependents: number, transitive: number): "low" | "medium" | "high" => {
  if (dependents === 0) return "low"
  const total = dependents + transitive
  if (total > 25 || dependents > 10) return "high"
  if (total > 6 || dependents > 3) return "medium"
  return "low"
}

export const computeBlastRadius = (
  deps: {
    readonly repo: CodegraphRepoInterface
    readonly analyzer: CodegraphAnalyzerInterface
  },
  input: typeof Input.Type,
): Effect.Effect<typeof Output.Type, never, never> =>
  Effect.gen(function* () {
    // Run the shared resolver first so the analyzer gets a nodeID back even
    // when the input is a qualified name, a Context.Service tag, or a
    // substring that only matches via code-substring. Previously we passed
    // `function: input.target` straight to `analyzer.impact`, which only
    // did exact-name lookups and returned 0 for everything except top-level
    // class names.
    const resolved = yield* resolveGraphTargetPure(deps.repo, { target: input.target })
    const resolvedNodeID = resolved._tag === "Ok" ? resolved.value.nodeID : undefined

    const impact = yield* deps.analyzer
      .impact(resolvedNodeID ? { nodeID: resolvedNodeID } : { function: input.target })
      .pipe(
        Effect.catchTag("Banyan/SymbolNotFoundError", () =>
          Effect.succeed({
            dependents: [] as Array<Banyan.CodegraphNode>,
            transitive: [] as Array<Banyan.CodegraphNode>,
          }),
        ),
      )

    const allFiles = yield* deps.repo.listAllFiles()
    const filePathByID = new Map(allFiles.map((f) => [f.id, f.path]))

    const seenFileIDs = new Set<string>()
    for (const node of [...impact.dependents, ...impact.transitive]) seenFileIDs.add(node.fileID)

    const filePaths: string[] = []
    for (const id of seenFileIDs) {
      const p = filePathByID.get(id)
      if (p) filePaths.push(p)
    }

    const testsToRun = filePaths.filter((p) => TEST_PATH.test(p)).length
    const transitiveCount = input.maxDepth ? Math.min(impact.transitive.length, BFS_MAX) : impact.transitive.length

    const metaRow = yield* deps.repo.getMeta()
    const meta = metaRow
      ? { graphBuiltAt: metaRow.graphBuiltAt, graphCoverage: metaRow.graphCoverage }
      : undefined
    const stale = isStale(meta)

    return {
      directCallers: impact.dependents.length,
      transitiveCallers: transitiveCount,
      filesAffected: seenFileIDs.size,
      testsToRun,
      risk: score(impact.dependents.length, transitiveCount),
      ...(stale.stale ? { graphStale: true } : {}),
    }
  })

export const makeBlastRadiusTool = (deps: {
  readonly permission: PermissionV2Interface
  readonly repo: CodegraphRepoInterface
  readonly analyzer: CodegraphAnalyzerInterface
}) =>
  Tool.make({
    description:
      "Use when:\n" +
      "  a lightweight, count-only blast-radius read of a symbol — direct + transitive\n" +
      "  dependents, files touched, tests to run, and a single-word risk verdict.\n" +
      "Examples\n" +
      '  - "How risky is changing MemoryRepo?"\n' +
      '  - "Rough blast radius of Permission.evaluate"\n' +
      "Returns\n" +
      "  { directCallers, transitiveCallers, filesAffected, testsToRun, risk }\n" +
      "Avoid when\n" +
      "  you need the actual list of callers, files, or routes — use preflight instead.\n" +
      "After this, often: preflight — for the full report.\n" +
      "Before this: codegraph_build (if not built).",
    contract: { visibility: "public" },
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [
      {
        type: "text",
        text:
          `directCallers=${output.directCallers} transitiveCallers=${output.transitiveCallers}\n` +
          `filesAffected=${output.filesAffected} testsToRun=${output.testsToRun}\n` +
          `risk=${output.risk}`,
      },
    ],
    execute: (input, context) =>
      traced(
        process.cwd(),
        context.sessionID,
        name,
        input,
        (output) =>
          `direct=${output.directCallers} transitive=${output.transitiveCallers} files=${output.filesAffected} tests=${output.testsToRun} risk=${output.risk}`,
        Effect.gen(function* () {
          yield* deps.permission.assert({
            action: name,
            resources: [input.target],
            save: ["*"],
            metadata: input,
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
          })
          return yield* computeBlastRadius({ repo: deps.repo, analyzer: deps.analyzer }, input)
        }),
      ).pipe(
        Effect.mapError((err) =>
          err instanceof ToolFailure ? err : new ToolFailure({ message: "blast_radius failed" }),
        ),
      ),
  })

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const repo = yield* Banyan.CodegraphRepo
    const analyzer = yield* Banyan.CodegraphAnalyzer

    yield* tools
      .register({
        [name]: makeBlastRadiusTool({
          permission: permission as PermissionV2Interface,
          repo: repo as CodegraphRepoInterface,
          analyzer: analyzer as CodegraphAnalyzerInterface,
        }),
      })
      .pipe(Effect.orDie)
  }),
).pipe(Layer.provide(codegraphAnalyzerLayer))

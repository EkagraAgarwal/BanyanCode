export * as BlastRadiusTool from "./blast-radius"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import type { Interface as CodegraphRepoInterface } from "../banyancode/codegraph-repo"
import type { Interface as CodegraphAnalyzerInterface } from "../banyancode/codegraph-analyzer"
import type { Interface as CodegraphReadinessInterface } from "../banyancode/codegraph-readiness"
import type { Interface as RepositoryIntelligenceInterface } from "../banyancode/repository-intelligence/service"
import type { Interface as PermissionV2Interface } from "../permission"
import { Banyan, isStale } from "../banyancode"
import { countStaleFilesFor } from "../banyancode/graph-staleness"
import { GraphMeta } from "../banyancode/types"
import { resolveGraphTargetPure } from "../banyancode/symbol-resolver"
import { traced } from "../observability/trace"
import { PermissionV2 } from "../permission"
import { toGraphMeta, staleInputFromMeta } from "./graph-meta"
import { Tool } from "./tool"
import { Tools } from "./tools"
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
  risk: Schema.Literals(["low", "medium", "high", "unknown"]),
  graphStale: Schema.optional(Schema.Boolean),
  // Phase 1 (freshness): how many affected files have an mtime newer than
  // their indexed_at — their indexed data may be stale. Absent when 0.
  staleFiles: Schema.optional(Schema.Number),
  meta: Schema.optional(GraphMeta),
  resolved: Schema.Boolean,
  resolutionDerivation: Schema.optional(
    Schema.Literals(["tag-fallback", "name-exact", "qualified-split", "code-substring", "name-like", "fts-bm25", "node-id"]),
  ),
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
    readonly intel: RepositoryIntelligenceInterface
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
    const isResolved = resolved._tag === "Ok"
    const resolvedNodeID = isResolved ? resolved.value.nodeID : undefined
    const resolvedPrimaryName = isResolved ? resolved.value.node.name : undefined
    const resolutionDerivation = isResolved ? resolved.value.derivation : undefined

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
    // Reverse lookup built once (O(n) prep) so the per-test-file scan below
    // is O(1) per entry instead of a linear entries().find() each time.
    const fileIDByPath = new Map(allFiles.map((f) => [f.path, f.id]))

    const seenFileIDs = new Set<string>()
    for (const node of [...impact.dependents, ...impact.transitive]) seenFileIDs.add(node.fileID)

    const filePaths: string[] = []
    for (const id of seenFileIDs) {
      const p = filePathByID.get(id)
      if (p) filePaths.push(p)
    }

    // Phase 2: align `testsToRun` with preflight. Caller-path tests alone
    // undercount when the resolver found a symbol with sparse edges
    // (Issue #2: blast_radius=0 vs preflight=181 on the same target).
    // Union in the broader `intel.tests({ symbol })` result so the two
    // tools agree for the same target.
    const testFileIDs = new Set<string>()
    for (const p of filePaths) {
      if (TEST_PATH.test(p)) {
        const id = fileIDByPath.get(p)
        if (id) testFileIDs.add(id)
      }
    }
    if (resolvedPrimaryName) {
      const testsList = yield* deps.intel.tests({ symbol: resolvedPrimaryName })
      for (const t of testsList.tests) testFileIDs.add(t.fileID)
    }
    const testsToRun = testFileIDs.size
    const transitiveCount = input.maxDepth ? Math.min(impact.transitive.length, BFS_MAX) : impact.transitive.length

    const metaRow = yield* deps.repo.getMeta()
    const stale = isStale(staleInputFromMeta(metaRow))
    const metaOut = toGraphMeta(metaRow)
    // Phase 1 (freshness): per-file drift over the affected file set — a
    // fresh meta can still sit on top of files that changed after indexing.
    const perFileStale = yield* countStaleFilesFor(deps.repo, [...seenFileIDs])

    // When the resolver fails to map the input to an indexed node we cannot
    // trust the count — `analyzer.impact` returns 0/0 for both "safe" and
    // "not found". Surface that ambiguity as `resolved: false` + `risk:
    // "unknown"` so an agent can't read a near-zero blast radius as proof of
    // safety. Counts are still reported (they may be useful for partial
    // overlap when the resolver missed via `name-like` but something was
    // resolved by `code-substring`), but the risk verdict is always "unknown"
    // on a miss so it cannot be misinterpreted.
    return {
      directCallers: impact.dependents.length,
      transitiveCallers: transitiveCount,
      filesAffected: seenFileIDs.size,
      testsToRun,
      risk: isResolved ? score(impact.dependents.length, transitiveCount) : "unknown",
      resolved: isResolved,
      ...(metaOut ? { meta: metaOut } : {}),
      ...(resolutionDerivation ? { resolutionDerivation } : {}),
      ...(stale.stale || perFileStale.stale ? { graphStale: true } : {}),
      ...(perFileStale.staleFiles > 0 ? { staleFiles: perFileStale.staleFiles } : {}),
    }
  })

export const makeBlastRadiusTool = (deps: {
  readonly permission: PermissionV2Interface
  readonly repo: CodegraphRepoInterface
  readonly analyzer: CodegraphAnalyzerInterface
  readonly intel: RepositoryIntelligenceInterface
  readonly readiness: CodegraphReadinessInterface
}) =>
  Tool.make({
    description:
      "Use when:\n" +
      "  a lightweight, count-only blast-radius read of a symbol — direct + transitive\n" +
      "  dependents, files touched, tests referencing the target by name/import OR\n" +
      "  living in the caller file set, and a single-word risk verdict.\n" +
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
          const ready = yield* deps.readiness.ensureReady({ root: path.resolve(process.cwd()) })
          if (ready.reason === "failed") {
            yield* Effect.logWarning(`blast_radius: readiness failed: ${ready.error ?? "unknown"}`)
          }
          return yield* computeBlastRadius({ repo: deps.repo, analyzer: deps.analyzer, intel: deps.intel }, input)
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
    const intel = yield* Banyan.RepositoryIntelligence
    const readiness = yield* Banyan.CodegraphReadiness

    yield* tools
      .register({
        [name]: makeBlastRadiusTool({
          permission: permission as PermissionV2Interface,
          repo: repo as CodegraphRepoInterface,
          analyzer: analyzer as CodegraphAnalyzerInterface,
          intel: intel as RepositoryIntelligenceInterface,
          readiness: readiness as CodegraphReadinessInterface,
        }),
      })
      .pipe(Effect.orDie)
  }),
)

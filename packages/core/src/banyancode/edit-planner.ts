export * as EditPlanner from "./edit-planner"

import { Context, Effect, Layer, Schema } from "effect"
import { CodegraphRepo } from "./codegraph-repo"
import { CodegraphAnalyzer, SymbolNotFoundError } from "./codegraph-analyzer"
import { resolveGraphTargetPure } from "./symbol-resolver"
import { isStale } from "./graph-staleness"
import type { CodegraphNode } from "./types"

const RiskSeverity = Schema.Literals(["low", "med", "high"])
const RiskKind = Schema.Literals(["stale-graph", "missing-tests", "external-caller", "no-target", "broad-impact"])

const EditStep = Schema.Struct({
  tool: Schema.String,
  args: Schema.Record(Schema.String, Schema.Unknown),
  rationale: Schema.String,
})

export const EditPlan = Schema.Struct({
  steps: Schema.Array(EditStep),
  expectedImpact: Schema.Struct({
    directDependents: Schema.Number,
    transitiveDependents: Schema.Number,
    testsToRun: Schema.Array(Schema.String),
    unreliable: Schema.optional(Schema.String),
  }),
  risks: Schema.Array(
    Schema.Struct({
      kind: RiskKind,
      severity: RiskSeverity,
      message: Schema.String,
    }),
  ),
})
export type EditPlan = typeof EditPlan.Type

export interface Interface {
  readonly planBeforeEdit: (input: {
    targetSymbol: string
    changeKind: "rename" | "modify" | "delete" | "add"
    filePath?: string
    root?: string
  }) => Effect.Effect<EditPlan, never, never>

  readonly planAfterEdit: (input: {
    targetSymbol: string
    filePath?: string
    root?: string
    diff?: string
  }) => Effect.Effect<EditPlan, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/EditPlanner") {}

const looksLikeTestFile = (path: string) =>
  /\.(test|spec)\.[^.]+$/.test(path) || /(^|\/)__tests__\//.test(path) || /(^|\/)tests?\//.test(path)

/**
 * Resolve a target symbol to an indexed node using the shared resolver.
 * Returns undefined when nothing matches so callers can branch on the miss.
 */
import type { Interface as CodegraphRepoInterface } from "./codegraph-repo"

const resolveTarget = (
  repo: CodegraphRepoInterface,
  targetSymbol: string,
): Effect.Effect<CodegraphNode | undefined, never, never> =>
  Effect.gen(function* () {
    // Cast at the boundary so the shared resolver's Pick<Interface, ...>
    // accepts the live Service instance.
    const result = yield* resolveGraphTargetPure(repo as never, { target: targetSymbol })
    return result._tag === "Ok" ? result.value.node : undefined
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service
    const analyzer = yield* CodegraphAnalyzer.Service

    const computeRisks = (input: {
      graphMeta: { graphBuiltAt: number; graphCoverage: number } | undefined
      transitiveDependents: number
      dependentPaths: string[]
    }) => {
      const risks: Array<{ kind: typeof RiskKind.Type; severity: typeof RiskSeverity.Type; message: string }> = []
      const stale = isStale(input.graphMeta)
      if (stale.stale && stale.reason) {
        risks.push({
          kind: "stale-graph",
          severity: stale.severity ?? "med",
          message: stale.reason,
        })
      }
      if (input.transitiveDependents > 50) {
        risks.push({
          kind: "broad-impact",
          severity: "high",
          message: `${input.transitiveDependents} transitive dependents; this is a high-blast-radius change`,
        })
      }
      const hasTest = input.dependentPaths.some(looksLikeTestFile)
      if (!hasTest && input.dependentPaths.length > 0) {
        risks.push({
          kind: "missing-tests",
          severity: "med",
          message: "no test files found in dependents; verify behavior with manual checks",
        })
      }
      return risks
    }

    const planBeforeEdit: Interface["planBeforeEdit"] = (input) =>
      Effect.gen(function* () {
        if (input.changeKind === "add") {
          const allNodes = yield* repo.listAllNodes()
          const allFiles = yield* repo.listAllFiles()
          const filePathMap = new Map<string, string>(allFiles.map((f) => [f.id, f.path]))
          const similar = allNodes
            .filter((n) => n.name.toLowerCase().includes(input.targetSymbol.toLowerCase()))
            .slice(0, 10)
          const graphMeta = yield* repo.getMeta()
          const meta = graphMeta
            ? { graphBuiltAt: graphMeta.graphBuiltAt, graphCoverage: graphMeta.graphCoverage }
            : undefined
          const stale = isStale(meta)
          const similarFilePath = similar[0] ? filePathMap.get(similar[0].fileID) ?? similar[0].fileID : undefined
          const addSteps: Array<{ tool: string; args: Record<string, unknown>; rationale: string }> = [
            {
              tool: "code_find",
              args: { intent: "definition", target: similar[0]?.name ?? input.targetSymbol },
              rationale: "look for similar symbols to follow naming patterns",
            },
          ]
          if (similarFilePath) {
            addSteps.push({
              tool: "read",
              args: { path: similarFilePath },
              rationale: "check the pattern used by a similarly-named symbol",
            })
          }
          return {
            steps: addSteps,
            expectedImpact: { directDependents: 0, transitiveDependents: 0, testsToRun: [] },
            risks: [
              { kind: "no-target", severity: "low", message: "new symbol; no existing callers to update" },
              ...(stale.stale && stale.reason
                ? [
                    {
                      kind: "stale-graph" as const,
                      severity: (stale.severity ?? "med") as "low" | "med" | "high",
                      message: stale.reason,
                    },
                  ]
                : []),
            ],
          }
        }

        const allNodes = yield* repo.listAllNodes()
        const target = yield* resolveTarget(repo, input.targetSymbol)
        const graphMeta = yield* repo.getMeta()

        if (!target) {
          return {
            steps: [
              { tool: "grep", args: { pattern: input.targetSymbol }, rationale: "no indexed node found; fall back to text search" },
              { tool: "code_find", args: { intent: "definition", target: input.targetSymbol }, rationale: "try the semantic search path" },
            ],
            expectedImpact: {
              directDependents: 0,
              transitiveDependents: 0,
              testsToRun: [],
              unreliable: `target "${input.targetSymbol}" not found in graph; dependents are unknown — run /codegraph-build --force to refresh`,
            },
            risks: [
              {
                kind: "no-target",
                severity: "high",
                message: `no indexed node named "${input.targetSymbol}"; graph may be stale or symbol may not exist`,
              },
            ],
          }
        }

        const impact = yield* analyzer.impact({ nodeID: target.id, function: target.name }).pipe(
          Effect.catchTag("Banyan/SymbolNotFoundError", () =>
            Effect.succeed({ dependents: [] as CodegraphNode[], transitive: [] as CodegraphNode[] })
          ),
        )
        const dependentPaths = impact.dependents.map((d: CodegraphNode) => d.fileID)
        const allFiles = yield* repo.listAllFiles()
        const filePathMap = new Map(allFiles.map((f) => [f.id, f.path]))
        const dependentFullPaths = dependentPaths.map((id: string) => filePathMap.get(id) ?? id)
        const testsToRun = dependentFullPaths.filter(looksLikeTestFile)

        const risks = computeRisks({
          graphMeta,
          transitiveDependents: impact.transitive.length,
          dependentPaths: dependentFullPaths,
        })

        const steps: Array<{ tool: string; args: Record<string, unknown>; rationale: string }> = []
        steps.push({
          tool: "code_find",
          args: { intent: "definition", target: input.targetSymbol },
          rationale: "locate the exact symbol",
        })
        if (input.changeKind === "rename") {
          steps.push({ tool: "code_find", args: { intent: "impact", target: input.targetSymbol }, rationale: "blast-radius before rename" })
        } else if (input.changeKind === "modify" || input.changeKind === "delete") {
          steps.push({
            tool: "code_find",
            args: { intent: "callers", target: input.targetSymbol },
            rationale: "find every caller before modifying/deleting",
          })
        }
        steps.push({
          tool: "read",
          args: { path: input.filePath ?? filePathMap.get(target.fileID) ?? target.fileID },
          rationale: "read the current implementation",
        })
        steps.push({ tool: "edit", args: { symbol: input.targetSymbol, kind: input.changeKind }, rationale: "perform the edit" })

        return {
          steps,
          expectedImpact: { directDependents: impact.dependents.length, transitiveDependents: impact.transitive.length, testsToRun },
          risks,
        }
      })

    const planAfterEdit: Interface["planAfterEdit"] = (input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(repo, input.targetSymbol)
        const graphMeta = yield* repo.getMeta()
        const callersRaw = target
          ? analyzer.callers({ nodeID: target.id, function: target.name }).pipe(
              Effect.catchTag("Banyan/SymbolNotFoundError", () => Effect.succeed([] as CodegraphNode[])),
            )
          : Effect.succeed([] as CodegraphNode[])
        const callers: CodegraphNode[] = yield* callersRaw
        const dependentPaths = callers.map((d: CodegraphNode) => d.fileID)
        const allFiles = yield* repo.listAllFiles()
        const filePathMap = new Map(allFiles.map((f) => [f.id, f.path]))
        const dependentFullPaths = dependentPaths.map((id: string) => filePathMap.get(id) ?? id)
        const testsToRun = dependentFullPaths.filter(looksLikeTestFile)
        const risks = computeRisks({
          graphMeta,
          transitiveDependents: callers.length,
          dependentPaths: dependentFullPaths,
        })
        return {
          steps: [
            { tool: "code_find", args: { intent: "callers", target: input.targetSymbol }, rationale: "re-verify callers after the edit" },
            { tool: "code_find", args: { intent: "impact", target: input.targetSymbol }, rationale: "re-check blast radius" },
            ...(testsToRun.length > 0
              ? [{ tool: "bash", args: { command: "bun test " + testsToRun.join(" ") }, rationale: "run affected tests" }]
              : []),
          ],
          expectedImpact: { directDependents: callers.length, transitiveDependents: callers.length, testsToRun },
          risks,
        }
      })

    return Service.of({ planBeforeEdit, planAfterEdit })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CodegraphAnalyzer.defaultLayer),
  Layer.provide(CodegraphRepo.defaultLayer),
)

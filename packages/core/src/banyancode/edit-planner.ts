export * as EditPlanner from "./edit-planner"

import { Context, Effect, Layer, Schema } from "effect"
import { CodegraphRepo } from "./codegraph-repo"
import { CodegraphAnalyzer } from "./codegraph-analyzer"
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
      const now = Date.now()
      if (input.graphMeta) {
        const ageMs = now - input.graphMeta.graphBuiltAt
        const oneDay = 24 * 60 * 60 * 1000
        if (ageMs > oneDay) {
          const days = Math.floor(ageMs / oneDay)
          risks.push({
            kind: "stale-graph",
            severity: ageMs > 7 * oneDay ? "high" : "med",
            message: `graph is ${days} day${days !== 1 ? "s" : ""} old; consider rebuilding before editing`,
          })
        }
        if (input.graphMeta.graphCoverage < 0.5) {
          risks.push({
            kind: "stale-graph",
            severity: "high",
            message: `graph coverage is ${(input.graphMeta.graphCoverage * 100).toFixed(0)}%; large parts of the codebase are unindexed`,
          })
        }
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
          const similar = allNodes
            .filter((n) => n.name.toLowerCase().includes(input.targetSymbol.toLowerCase()))
            .slice(0, 10)
          const graphMeta = yield* repo.getMeta()
          return {
            steps: [
              {
                tool: "code_find",
                args: { intent: "definition", target: similar[0]?.name ?? input.targetSymbol },
                rationale: "look for similar symbols to follow naming patterns",
              },
            ],
            expectedImpact: { directDependents: 0, transitiveDependents: 0, testsToRun: [] },
            risks: [
              { kind: "no-target", severity: "low", message: "new symbol; no existing callers to update" },
              ...(graphMeta && Date.now() - graphMeta.graphBuiltAt > 7 * 24 * 60 * 60 * 1000
                ? [
                    {
                      kind: "stale-graph" as const,
                      severity: "med" as const,
                      message: "graph is over a week old; consider rebuilding",
                    },
                  ]
                : []),
            ],
          }
        }

        const allNodes = yield* repo.listAllNodes()
        const target = allNodes.find((n) => n.name === input.targetSymbol)
        const graphMeta = yield* repo.getMeta()

        if (!target) {
          return {
            steps: [
              { tool: "grep", args: { pattern: input.targetSymbol }, rationale: "no indexed node found; fall back to text search" },
              { tool: "code_find", args: { intent: "definition", target: input.targetSymbol }, rationale: "try the semantic search path" },
            ],
            expectedImpact: { directDependents: 0, transitiveDependents: 0, testsToRun: [] },
            risks: [
              {
                kind: "no-target",
                severity: "high",
                message: `no indexed node named "${input.targetSymbol}"; graph may be stale or symbol may not exist`,
              },
            ],
          }
        }

        const impact = yield* analyzer.impact({ function: input.targetSymbol })
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
        steps.push({ tool: "read", args: { path: input.filePath ?? "" }, rationale: "read the current implementation" })
        steps.push({ tool: "edit", args: { symbol: input.targetSymbol, kind: input.changeKind }, rationale: "perform the edit" })

        return {
          steps,
          expectedImpact: { directDependents: impact.dependents.length, transitiveDependents: impact.transitive.length, testsToRun },
          risks,
        }
      })

    const planAfterEdit: Interface["planAfterEdit"] = (input) =>
      Effect.gen(function* () {
        const allNodes = yield* repo.listAllNodes()
        const target = allNodes.find((n) => n.name === input.targetSymbol)
        const graphMeta = yield* repo.getMeta()
        const callers = target ? yield* analyzer.callers({ function: input.targetSymbol }) : []
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

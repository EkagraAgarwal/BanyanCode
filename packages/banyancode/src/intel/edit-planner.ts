import { Effect } from "effect"
import { bfs } from "./bfs.js"
import type { CodegraphPort } from "./codegraph-port.js"
import { ALL_EDGE_KINDS, CALLER_EDGE_KINDS, resolveGraphTarget } from "./resolve.js"
import { isStale } from "./staleness.js"
import type { EditPlan, GraphNode } from "./types.js"

/**
 * Edit planner, ported from v1 `packages/core/src/banyancode/edit-planner.ts`.
 * Pure graph reads over `CodegraphPort`; no tool calls are executed.
 */

const looksLikeTestFile = (path: string): boolean =>
  /\.(test|spec)\.[^.]+$/.test(path) || /(^|\/)__tests__\//.test(path) || /(^|\/)tests?\//.test(path)

export interface EditPlannerInterface {
  readonly planBeforeEdit: (input: {
    targetSymbol: string
    changeKind: "rename" | "modify" | "delete" | "add"
    filePath?: string
    root?: string
    preResolvedTarget?: GraphNode
  }) => Effect.Effect<EditPlan>
  readonly planAfterEdit: (input: {
    targetSymbol: string
    filePath?: string
    root?: string
    diff?: string
  }) => Effect.Effect<EditPlan>
}

export const makeEditPlanner = (port: CodegraphPort): EditPlannerInterface => {
  const impact = (nodeID: string): Effect.Effect<{ dependents: GraphNode[]; transitive: GraphNode[] }> =>
    Effect.gen(function* () {
      const run = yield* bfs(port, {
        start: [nodeID],
        direction: "incoming",
        edgeKinds: ALL_EDGE_KINDS,
        maxDepth: 8,
        resultLimit: 500,
      })
      const dependents: GraphNode[] = []
      const transitive: GraphNode[] = []
      for (const result of run.results) {
        if (result.depth === 1) dependents.push(result.node)
        else transitive.push(result.node)
      }
      return { dependents, transitive }
    })

  const computeRisks = (input: {
    graphMeta: { graphBuiltAt: number; graphCoverage: number } | undefined
    transitiveDependents: number
    dependentPaths: string[]
  }): EditPlan["risks"] => {
    const risks: Array<{ kind: EditPlan["risks"][number]["kind"]; severity: "low" | "med" | "high"; message: string }> = []
    const stale = isStale(input.graphMeta)
    if (stale.stale && stale.reason) {
      risks.push({ kind: "stale-graph", severity: stale.severity ?? "med", message: stale.reason })
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

  const planBeforeEdit: EditPlannerInterface["planBeforeEdit"] = (input) =>
    Effect.gen(function* () {
      const meta = yield* port.meta()
      const graphMeta = meta ? { graphBuiltAt: meta.graphBuiltAt, graphCoverage: meta.graphCoverage } : undefined

      if (input.changeKind === "add") {
        const nodes = port.listNodes ? yield* port.listNodes({ limit: 100_000 }) : []
        const files = yield* port.listFiles()
        const filePathMap = new Map(files.map((file) => [file.id, file.path]))
        const similar = nodes
          .filter((node) => node.name.toLowerCase().includes(input.targetSymbol.toLowerCase()))
          .slice(0, 10)
        const stale = isStale(graphMeta)
        const similarFilePath = similar[0] ? filePathMap.get(similar[0].fileID) ?? similar[0].fileID : undefined
        const steps: Array<{ tool: string; args: Record<string, unknown>; rationale: string }> = [
          {
            tool: "code_find",
            args: { intent: "definition", target: similar[0]?.name ?? input.targetSymbol },
            rationale: "look for similar symbols to follow naming patterns",
          },
          ...(similarFilePath
            ? [
                {
                  tool: "read",
                  args: { path: similarFilePath },
                  rationale: "check the pattern used by a similarly-named symbol",
                },
              ]
            : []),
        ]
        return {
          steps,
          expectedImpact: { directDependents: 0, transitiveDependents: 0, testsToRun: [] },
          risks: [
            { kind: "no-target", severity: "low", message: "new symbol; no existing callers to update" },
            ...(stale.stale && stale.reason
              ? [{ kind: "stale-graph" as const, severity: (stale.severity ?? "med") as "low" | "med" | "high", message: stale.reason }]
              : []),
          ],
        }
      }

      const target =
        input.preResolvedTarget ??
        (yield* Effect.gen(function* () {
          const resolution = yield* resolveGraphTarget(port, { target: input.targetSymbol })
          return resolution._tag === "Ok" ? resolution.value.node : undefined
        }))

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
        } satisfies EditPlan
      }

      const run = yield* impact(target.id)
      const files = yield* port.listFiles()
      const filePathMap = new Map(files.map((file) => [file.id, file.path]))
      const dependentPaths = run.dependents.map((node) => filePathMap.get(node.fileID) ?? node.fileID)
      const testsToRun = dependentPaths.filter(looksLikeTestFile)

      const steps: Array<{ tool: string; args: Record<string, unknown>; rationale: string }> = []
      if (!(input.filePath && input.preResolvedTarget)) {
        steps.push({ tool: "code_find", args: { intent: "definition", target: input.targetSymbol }, rationale: "locate the exact symbol" })
      }
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
        args: { path: filePathMap.get(target.fileID) ?? input.filePath ?? target.fileID },
        rationale: "read the current implementation",
      })
      steps.push({ tool: "edit", args: { symbol: input.targetSymbol, kind: input.changeKind }, rationale: "perform the edit" })

      return {
        steps,
        expectedImpact: {
          directDependents: run.dependents.length,
          transitiveDependents: run.transitive.length,
          testsToRun,
        },
        risks: computeRisks({ graphMeta, transitiveDependents: run.transitive.length, dependentPaths }),
      }
    })

  const planAfterEdit: EditPlannerInterface["planAfterEdit"] = (input) =>
    Effect.gen(function* () {
      const resolution = yield* resolveGraphTarget(port, { target: input.targetSymbol })
      const target = resolution._tag === "Ok" ? resolution.value.node : undefined
      const meta = yield* port.meta()
      const graphMeta = meta ? { graphBuiltAt: meta.graphBuiltAt, graphCoverage: meta.graphCoverage } : undefined

      const callers: GraphNode[] = target
        ? (yield* bfs(port, { start: [target.id], direction: "incoming", edgeKinds: CALLER_EDGE_KINDS, maxDepth: 1 })).results.map(
            (result) => result.node,
          )
        : []

      const files = yield* port.listFiles()
      const filePathMap = new Map(files.map((file) => [file.id, file.path]))
      const dependentPaths = callers.map((node) => filePathMap.get(node.fileID) ?? node.fileID)
      const testsToRun = dependentPaths.filter(looksLikeTestFile)

      return {
        steps: [
          { tool: "code_find", args: { intent: "callers", target: input.targetSymbol }, rationale: "re-verify callers after the edit" },
          { tool: "code_find", args: { intent: "impact", target: input.targetSymbol }, rationale: "re-check blast radius" },
          ...(testsToRun.length > 0
            ? [{ tool: "bash", args: { command: "bun test " + testsToRun.join(" ") }, rationale: "run affected tests" }]
            : []),
        ],
        expectedImpact: { directDependents: callers.length, transitiveDependents: callers.length, testsToRun },
        risks: computeRisks({ graphMeta, transitiveDependents: callers.length, dependentPaths }),
      }
    })

  return { planBeforeEdit, planAfterEdit }
}

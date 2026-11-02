import { Effect } from "effect"
import { bfs } from "./bfs.js"
import type { CodegraphPort } from "./codegraph-port.js"
import type { EditPlannerInterface } from "./edit-planner.js"
import { computePreflight } from "./preflight.js"
import { ALL_EDGE_KINDS, resolveGraphTarget } from "./resolve.js"
import type { Interface as Intelligence } from "./service.js"
import type { Risk, SafeRenameInput, SafeRenameOutput } from "./types.js"

/**
 * Safe rename planner, ported from v1
 * `packages/core/src/tool/safe-rename.ts`. The tool never writes files: it
 * returns per-call-site edits, tests to run, planner risks, and the full
 * preflight report.
 */

export class RenamePlanError extends Error {}

const resolveNewName = (
  oldSymbol: string,
  newName: string,
): { namespace: string; leaf: string } | undefined => {
  if (newName.includes(".")) {
    const parts = newName.split(".")
    const leaf = parts.pop()!
    const namespace = parts.join(".")
    if (namespace.length === 0) return undefined
    return { namespace, leaf }
  }
  const oldParts = oldSymbol.split(".")
  const oldLeaf = oldParts.pop()
  if (!oldLeaf || oldParts.length === 0) return undefined
  return { namespace: oldParts.join("."), leaf: newName }
}

const namespaceFailureMessage = (input: { symbol: string; newName: string }): string => {
  const symbolBare = !input.symbol.includes(".")
  const newNameBare = !input.newName.includes(".")
  if (symbolBare && newNameBare) {
    return (
      `safe_rename: cannot resolve namespace because both inputs are bare ` +
      `("symbol=${input.symbol}", "newName=${input.newName}"). ` +
      `Pass a qualified symbol like "Namespace.${input.symbol}" (or a qualified newName like "Namespace.${input.newName}") so the tool knows where the rename belongs.`
    )
  }
  return (
    `safe_rename: cannot derive a namespace from newName="${input.newName}". ` +
    `newName must be a qualified name with a non-empty namespace, e.g. "Namespace.${input.newName.startsWith(".") ? input.newName.slice(1) : input.newName}".`
  )
}

export interface SafeRenameDeps {
  readonly port: CodegraphPort
  readonly intel: Intelligence
  readonly planner: EditPlannerInterface
}

export const computeSafeRename = (
  deps: SafeRenameDeps,
  input: SafeRenameInput,
): Effect.Effect<SafeRenameOutput, RenamePlanError> =>
  Effect.gen(function* () {
    const split = resolveNewName(input.symbol, input.newName)
    if (!split) return yield* Effect.fail(new RenamePlanError(namespaceFailureMessage(input)))

    const resolution = yield* resolveGraphTarget(deps.port, { target: input.symbol })
    const targetNode = resolution._tag === "Ok" ? resolution.value.node : undefined
    const oldLeaf = input.symbol.split(".").pop() ?? input.symbol
    const newLeaf = split.leaf

    const callSiteFiles = new Map<string, { line: number }>()
    if (targetNode) {
      const run = yield* bfs(deps.port, {
        start: [targetNode.id],
        direction: "incoming",
        edgeKinds: ALL_EDGE_KINDS,
        maxDepth: 1,
        resultLimit: 500,
      })
      for (const result of run.results) callSiteFiles.set(result.node.fileID, { line: result.node.startLine })
    }

    const allFiles = yield* deps.port.listFiles()
    const filePathByID = new Map(allFiles.map((file) => [file.id, file.path]))

    const edits: Array<{ file: string; oldText: string; newText: string; line: number }> = []
    for (const [fileID, meta] of callSiteFiles) {
      const filePath = filePathByID.get(fileID)
      if (!filePath) continue
      edits.push({ file: filePath, oldText: oldLeaf, newText: newLeaf, line: meta.line })
    }

    const testPaths = new Set<string>()
    if (targetNode) {
      const tests = yield* deps.intel.tests({ symbol: targetNode.name })
      for (const test of tests.tests) {
        const file = allFiles.find((candidate) => candidate.id === test.fileID)
        if (file) testPaths.add(file.path)
      }
    }

    const filePathForTarget = targetNode ? filePathByID.get(targetNode.fileID) : undefined
    const plannerPlan = yield* deps.planner.planBeforeEdit({
      targetSymbol: input.symbol,
      changeKind: "rename",
      ...(filePathForTarget ? { filePath: filePathForTarget } : {}),
      ...(input.root ? { root: input.root } : {}),
    })

    const risks: Risk[] = plannerPlan.risks.map((risk) => ({
      kind: risk.kind,
      severity: risk.severity === "med" ? "medium" : risk.severity,
      message: risk.message,
    }))

    const preflight = yield* computePreflight(
      { port: deps.port, intel: deps.intel },
      { action: "rename", target: input.symbol, ...(input.root ? { root: input.root } : {}) },
    )

    const meta = yield* deps.port.meta()
    return {
      edits: input.dryRun ? [] : edits,
      testsToRun: [...testPaths],
      risks,
      preflight,
      ...(meta
        ? {
            meta: {
              graphBuiltAt: meta.graphBuiltAt,
              graphVersion: meta.graphVersion,
              graphCoverage: meta.graphCoverage,
              totalFiles: meta.totalFiles,
              totalNodes: meta.totalNodes,
              totalEdges: meta.totalEdges,
            },
          }
        : {}),
    }
  })

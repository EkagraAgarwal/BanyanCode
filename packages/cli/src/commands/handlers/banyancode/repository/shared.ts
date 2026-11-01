import type { ArchitecturalSlice, GraphNode } from "../rpc"
import { dim, println, Style } from "../ui"

/** v1 `printSliceSummary` (`cli/cmd/repository.ts`). */
export const printSliceSummary = (slice: ArchitecturalSlice) => {
  println(Style.TEXT_HIGHLIGHT + slice.summary + Style.TEXT_NORMAL)
  println(
    dim(
      `entrypoints=${slice.entrypoints.length} symbols=${slice.importantSymbols.length} tests=${slice.relatedTests.length} docs=${slice.relatedDocs.length} configs=${slice.configs.length} routes=${slice.routes.length}`,
    ),
  )
}

/** v1 `printNodeList`. */
export const printNodeList = (nodes: ReadonlyArray<GraphNode>, limit = 10) => {
  if (nodes.length === 0) {
    println(dim("  (none)"))
    return
  }
  for (const node of nodes.slice(0, limit)) {
    println(`  ${node.name}  ${dim(node.signature ?? node.kind)}`)
  }
  if (nodes.length > limit) println(dim(`  ...${nodes.length - limit} more`))
}

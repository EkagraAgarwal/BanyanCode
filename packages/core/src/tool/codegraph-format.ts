import type { CodegraphNode } from "../banyancode/types"

const MAX_NODES_PER_OUTPUT = 25

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "\u2026"

const renderNodeLine = (node: CodegraphNode): string => {
  const sig = node.signature ? ` ${truncate(node.signature, 80)}` : ""
  return `${node.kind} ${node.name} (${node.fileID}:${node.startLine}-${node.endLine})${sig}`
}

const renderNodesBlock = (nodes: readonly CodegraphNode[], header: string): string => {
  if (nodes.length === 0) return `${header}: none.`
  const visible = nodes.slice(0, MAX_NODES_PER_OUTPUT)
  const lines = visible.map(renderNodeLine)
  const remaining = nodes.length - visible.length
  const tail = remaining > 0 ? `\n... and ${remaining} more (see structured output for the full list).` : ""
  return `${header} (${nodes.length}):\n${lines.join("\n")}${tail}`
}

export const formatNodes = (nodes: readonly CodegraphNode[], header = "Nodes"): string =>
  renderNodesBlock(nodes, header)

export const formatCodegraphSearchResults = (
  results: ReadonlyArray<{ node: CodegraphNode; score: number }>,
): string => {
  if (results.length === 0) return "Search returned no results."
  const visible = results.slice(0, MAX_NODES_PER_OUTPUT)
  const lines = visible.map((r) => `[score=${r.score.toFixed(2)}] ${renderNodeLine(r.node)}`)
  const remaining = results.length - visible.length
  const tail = remaining > 0 ? `\n... and ${remaining} more (see structured output for the full list).` : ""
  return `Search results (${results.length}):\n${lines.join("\n")}${tail}`
}
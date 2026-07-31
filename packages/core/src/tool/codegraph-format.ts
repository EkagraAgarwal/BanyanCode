import type { CodegraphFile, CodegraphNode } from "../banyancode/types"

const MAX_NODES_PER_OUTPUT = 25

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "\u2026"

// When `filesByID` is provided and the node's `fileID` resolves, render the
// relative path so the agent can `read` the file directly without a follow-up
// `find_file` / `codegraph_query` call. Otherwise fall back to the UUID —
// preserves the prior contract for callers that don't opt in.
const renderNodeLine = (
  node: CodegraphNode,
  filesByID?: ReadonlyMap<string, CodegraphFile>,
): string => {
  const sig = node.signature ? ` ${truncate(node.signature, 80)}` : ""
  const path = filesByID?.get(node.fileID)?.path
  const loc = path
    ? `${path}:${node.startLine}-${node.endLine}`
    : `${node.fileID}:${node.startLine}-${node.endLine}`
  return `${node.kind} ${node.name} (${loc})${sig}`
}

const renderNodesBlock = (
  nodes: readonly CodegraphNode[],
  header: string,
  filesByID?: ReadonlyMap<string, CodegraphFile>,
): string => {
  if (nodes.length === 0) return `${header}: none.`
  const visible = nodes.slice(0, MAX_NODES_PER_OUTPUT)
  const lines = visible.map((n) => renderNodeLine(n, filesByID))
  const remaining = nodes.length - visible.length
  const tail = remaining > 0 ? `\n... and ${remaining} more (see structured output for the full list).` : ""
  return `${header} (${nodes.length}):\n${lines.join("\n")}${tail}`
}

export const formatNodes = (
  nodes: readonly CodegraphNode[],
  header = "Nodes",
  filesByID?: ReadonlyMap<string, CodegraphFile>,
): string => renderNodesBlock(nodes, header, filesByID)

export const formatCodegraphSearchResults = (
  results: ReadonlyArray<{ node: CodegraphNode; score: number }>,
  filesByID?: ReadonlyMap<string, CodegraphFile>,
): string => {
  if (results.length === 0) return "Search returned no results."
  const visible = results.slice(0, MAX_NODES_PER_OUTPUT)
  const lines = visible.map((r) => `[score=${r.score.toFixed(2)}] ${renderNodeLine(r.node, filesByID)}`)
  const remaining = results.length - visible.length
  const tail = remaining > 0 ? `\n... and ${remaining} more (see structured output for the full list).` : ""
  return `Search results (${results.length}):\n${lines.join("\n")}${tail}`
}
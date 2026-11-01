/**
 * Model-facing text formatters, ported from v1
 * `packages/core/src/tool/repository-format.ts`. Same sections, same
 * truncation at 50 items, so tool answers read the same as v1.
 */

import type { ArchitecturalSlice, GraphFile, GraphNode, RepositoryContext } from "./types.js"

const MAX_ITEMS_PER_OUTPUT = 50

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : value.slice(0, Math.max(0, max - 1)) + "\u2026"

const renderNodeLine = (node: GraphNode): string =>
  `${node.kind} ${node.name} (${node.fileID}:${node.startLine}-${node.endLine})`

const renderFileLine = (file: { path: string; language?: string }): string =>
  `${file.path}${file.language ? ` [${file.language}]` : ""}`

const renderNodesBlock = (nodes: readonly GraphNode[], header: string): string => {
  if (nodes.length === 0) return `${header}: none.`
  const visible = nodes.slice(0, MAX_ITEMS_PER_OUTPUT)
  const remaining = nodes.length - visible.length
  return `${header} (${nodes.length}):\n${visible.map(renderNodeLine).join("\n")}${
    remaining > 0 ? `\n... and ${remaining} more.` : ""
  }`
}

const renderFilesBlock = (files: readonly GraphFile[], header: string): string => {
  if (files.length === 0) return `${header}: none.`
  const visible = files.slice(0, MAX_ITEMS_PER_OUTPUT)
  const remaining = files.length - visible.length
  return `${header} (${files.length}):\n${visible.map(renderFileLine).join("\n")}${
    remaining > 0 ? `\n... and ${remaining} more.` : ""
  }`
}

const statusBlock = (value: {
  status?: "success" | "partial" | "failed"
  reason?: string
  recoveryHint?: string
  fallbackUsed?: boolean
  diagnostics?: readonly { kind: string; message: string }[]
}): string[] => {
  const lines: string[] = []
  if (value.status) {
    lines.push(`Status: ${value.status.toUpperCase()}`)
    if (value.reason) lines.push(`Reason: ${value.reason}`)
    if (value.recoveryHint) lines.push(`Recovery Hint: ${value.recoveryHint}`)
    if (value.fallbackUsed) lines.push(`[Note: resolved via Context.Service tag fallback]`)
  }
  if (value.diagnostics && value.diagnostics.length > 0) {
    lines.push("Diagnostics:")
    for (const diagnostic of value.diagnostics) lines.push(`  [${diagnostic.kind}] ${diagnostic.message}`)
  }
  return lines.length > 0 ? [lines.join("\n")] : []
}

export const formatArchitecturalSlice = (slice: ArchitecturalSlice): string =>
  [
    ...statusBlock(slice),
    truncate(slice.summary, 600),
    renderNodesBlock(slice.entrypoints, "Entrypoints"),
    renderNodesBlock(slice.directCallers, "Direct callers"),
    renderNodesBlock(slice.transitiveDependents, "Top transitive dependents"),
    ...((slice.moreAvailable?.dependents ?? 0) > 0
      ? [`(${slice.moreAvailable?.dependents} more transitive dependents not shown; pass limit: <N> to see more)`]
      : []),
    renderNodesBlock(slice.importantSymbols, "Important symbols"),
    renderNodesBlock(slice.routes, "Routes"),
    renderNodesBlock(slice.relatedTests, "Related tests"),
    renderFilesBlock(slice.relatedDocs, "Related docs"),
    renderFilesBlock(slice.configs, "Configs"),
    `Dependencies (${slice.dependencies.length}): ${
      slice.dependencies.length === 0
        ? "none"
        : slice.dependencies
            .slice(0, MAX_ITEMS_PER_OUTPUT)
            .map((dependency) => `${dependency.name}${dependency.version ? `@${dependency.version}` : ""}`)
            .join(", ")
    }`,
  ].join("\n\n")

export const formatRepositoryContext = (ctx: RepositoryContext): string => {
  const ownership = ctx.git.ownership
  const ownershipLines: string[] = []
  if (ownership.length === 0) {
    ownershipLines.push("Ownership: none.")
  } else {
    const visible = ownership.slice(0, MAX_ITEMS_PER_OUTPUT)
    const remaining = ownership.length - visible.length
    ownershipLines.push(
      `Ownership (${ownership.length}):\n${visible.map((entry) => `  ${entry.path}: ${entry.count} commit(s)`).join("\n")}${
        remaining > 0 ? `\n... and ${remaining} more.` : ""
      }`,
    )
  }

  return [
    ...statusBlock(ctx),
    `Repository query: ${ctx.query}`,
    renderNodesBlock(ctx.symbols, "Symbols"),
    renderFilesBlock(ctx.files, "Files"),
    renderNodesBlock(ctx.tests, "Tests"),
    renderFilesBlock(ctx.docs, "Docs"),
    renderFilesBlock(ctx.configs, "Configs"),
    renderNodesBlock(ctx.graph.nodes, "Graph nodes"),
    `Graph edges: ${ctx.graph.edges.length}.`,
    ctx.git.recentCommits.length === 0
      ? "Recent commits: none."
      : `Recent commits (${ctx.git.recentCommits.length}):\n${ctx.git.recentCommits
          .slice(0, MAX_ITEMS_PER_OUTPUT)
          .map((commit) => `  ${commit.sha} ${truncate(commit.subject, 100)}`)
          .join("\n")}${ctx.git.recentCommits.length > MAX_ITEMS_PER_OUTPUT ? "\n... and more." : ""}`,
    ...ownershipLines,
  ].join("\n\n")
}

export const formatNodesList = (nodes: readonly GraphNode[], header: string): string => renderNodesBlock(nodes, header)

export const formatOwnership = (owner: string | undefined, count: number): string =>
  owner
    ? `Owner: ${owner}\nCommits touching this path: ${count}`
    : `No owner found for this path (0 commits in the indexed history). If a path is provided, ensure the workspace is a git repository with commit history.`

import type { ArchitecturalSlice, CodegraphFile, CodegraphNode, TestMatchDerivation } from "../banyancode/types"

const MAX_ITEMS_PER_OUTPUT = 50

type OwnershipEntry = { path: string; count: number }

type DetailedTest = { node: CodegraphNode; derivation: TestMatchDerivation | "none"; confidence: number }

export type FormatRepositoryContext = {
  status?: "success" | "partial" | "failed"
  reason?: string
  recoveryHint?: string
  fallbackUsed?: boolean
  degraded?: boolean
  query: string
  symbols: readonly CodegraphNode[]
  files: readonly CodegraphFile[]
  graph: { nodes: readonly CodegraphNode[]; edges: ReadonlyArray<unknown> }
  tests: readonly CodegraphNode[]
  testsDetailed?: readonly DetailedTest[]
  docs: readonly CodegraphFile[]
  configs: readonly CodegraphFile[]
  git: {
    recentCommits: ReadonlyArray<{ sha: string; subject: string; ts: number }>
    ownership: ReadonlyArray<OwnershipEntry> | ReadonlyMap<string, number>
  }
  diagnostics?: readonly { kind: string; message: string }[]
  ambiguity?: { total: number; kept: number }
  searchDerivation?: string
}

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "\u2026"

const renderNodeLine = (node: CodegraphNode): string =>
  `${node.kind} ${node.name} (${node.fileID}:${node.startLine}-${node.endLine})`

const renderFileLine = (file: { path: string; language?: string }): string => {
  const lang = file.language ? ` [${file.language}]` : ""
  return `${file.path}${lang}`
}

const renderNodesBlock = (nodes: readonly CodegraphNode[], header: string): string => {
  if (nodes.length === 0) return `${header}: none.`
  const visible = nodes.slice(0, MAX_ITEMS_PER_OUTPUT)
  const lines = visible.map(renderNodeLine)
  const remaining = nodes.length - visible.length
  const tail = remaining > 0 ? `\n... and ${remaining} more.` : ""
  return `${header} (${nodes.length}):\n${lines.join("\n")}${tail}`
}

const renderFilesBlock = (files: readonly CodegraphFile[], header: string): string => {
  if (files.length === 0) return `${header}: none.`
  const visible = files.slice(0, MAX_ITEMS_PER_OUTPUT)
  const lines = visible.map(renderFileLine)
  const remaining = files.length - visible.length
  const tail = remaining > 0 ? `\n... and ${remaining} more.` : ""
  return `${header} (${files.length}):\n${lines.join("\n")}${tail}`
}

export type FormatArchitecturalSlice = ArchitecturalSlice & {
  status?: "success" | "partial" | "failed"
  reason?: string
  recoveryHint?: string
  fallbackUsed?: boolean
  degraded?: boolean
  diagnostics?: readonly { kind: string; message: string }[]
}

const renderDetailedTestsBlock = (detailed: readonly DetailedTest[] | undefined, tests: readonly CodegraphNode[], header: string): string => {
  if (tests.length === 0) return `${header}: none.`
  if (detailed && detailed.length > 0) {
    const visible = detailed.slice(0, MAX_ITEMS_PER_OUTPUT)
    const lines = visible.map(
      (r) => `${r.node.kind} ${r.node.name} (${r.node.fileID}:${r.node.startLine}-${r.node.endLine}) [${r.derivation}, conf ${r.confidence}]`,
    )
    const remaining = tests.length - visible.length
    const tail = remaining > 0 ? `\n... and ${remaining} more.` : ""
    return `${header} (${tests.length}):\n${lines.join("\n")}${tail}`
  }
  return renderNodesBlock(tests, header)
}

export const formatArchitecturalSlice = (slice: FormatArchitecturalSlice): string => {
  const statusLines: string[] = []
  if (slice.status) {
    statusLines.push(`Status: ${slice.status.toUpperCase()}`)
    if (slice.reason) statusLines.push(`Reason: ${slice.reason}`)
    if (slice.recoveryHint) statusLines.push(`Recovery Hint: ${slice.recoveryHint}`)
    if (slice.fallbackUsed) statusLines.push(`[Note: resolved via Context.Service tag fallback]`)
  }

  const noteLines: string[] = []
  if (slice.diagnostics && slice.diagnostics.length > 0) {
    noteLines.push(`Diagnostics:`)
    for (const d of slice.diagnostics) {
      noteLines.push(`  [${d.kind}] ${d.message}`)
    }
  }

  return [
    ...(statusLines.length > 0 ? [statusLines.join("\n")] : []),
    ...(noteLines.length > 0 ? [noteLines.join("\n")] : []),
    truncate(slice.summary, 600),
    renderNodesBlock(slice.entrypoints, "Entrypoints"),
    renderNodesBlock(slice.directCallers, "Direct callers"),
    renderNodesBlock(slice.transitiveDependents, "Top transitive dependents"),
    ...(slice.moreAvailable && (slice.moreAvailable.dependents ?? 0) > 0
      ? [`(${slice.moreAvailable.dependents ?? 0} more transitive dependents not shown; pass limit: <N> to see more)`]
      : []),
    renderNodesBlock(slice.importantSymbols, "Important symbols"),
    renderNodesBlock(slice.routes, "Routes"),
    renderDetailedTestsBlock(slice.relatedTestsDetailed, slice.relatedTests, "Related tests"),
    renderFilesBlock(slice.relatedDocs, "Related docs"),
    renderFilesBlock(slice.configs, "Configs"),
    `Dependencies (${slice.dependencies.length}): ${
      slice.dependencies.length === 0
        ? "none"
        : slice.dependencies
            .slice(0, MAX_ITEMS_PER_OUTPUT)
            .map((d) => `${d.name}${d.version ? `@${d.version}` : ""}`)
            .join(", ")
    }`,
  ].join("\n\n")
}

export const formatRepositoryContext = (ctx: FormatRepositoryContext): string => {
  const ownershipEntries: OwnershipEntry[] =
    "entries" in (ctx.git.ownership as object)
      ? Array.from(ctx.git.ownership as ReadonlyMap<string, number>, ([path, count]) => ({ path, count }))
      : ([...ctx.git.ownership] as OwnershipEntry[])

  const ownershipLines: string[] = []
  if (ownershipEntries.length === 0) {
    ownershipLines.push("Ownership: none.")
  } else {
    const visible = ownershipEntries.slice(0, MAX_ITEMS_PER_OUTPUT)
    const lines = visible.map((o) => `  ${o.path}: ${o.count} commit(s)`)
    const remaining = ownershipEntries.length - visible.length
    const tail = remaining > 0 ? `\n... and ${remaining} more.` : ""
    ownershipLines.push(`Ownership (${ownershipEntries.length}):\n${lines.join("\n")}${tail}`)
  }

  const statusLines: string[] = []
  if (ctx.status) {
    statusLines.push(`Status: ${ctx.status.toUpperCase()}`)
    if (ctx.reason) statusLines.push(`Reason: ${ctx.reason}`)
    if (ctx.recoveryHint) statusLines.push(`Recovery Hint: ${ctx.recoveryHint}`)
    if (ctx.fallbackUsed) statusLines.push(`[Note: resolved via Context.Service tag fallback]`)
  }
  if (ctx.ambiguity && ctx.ambiguity.total > 1) {
    statusLines.push(`[Note: "${ctx.query}" matched ${ctx.ambiguity.total} candidate nodes; ${ctx.ambiguity.kept} shown — pass focusDirs to disambiguate]`)
  }
  if (ctx.searchDerivation) {
    statusLines.push(`[Note: symbol resolution derivation: ${ctx.searchDerivation}]`)
  }

  const noteLines: string[] = []
  if (ctx.diagnostics && ctx.diagnostics.length > 0) {
    noteLines.push(`Diagnostics:`)
    for (const d of ctx.diagnostics) {
      noteLines.push(`  [${d.kind}] ${d.message}`)
    }
  }

  return [
    ...(statusLines.length > 0 ? [statusLines.join("\n")] : []),
    ...(noteLines.length > 0 ? [noteLines.join("\n")] : []),
    `Repository query: ${ctx.query}`,
    renderNodesBlock(ctx.symbols, "Symbols"),
    renderFilesBlock(ctx.files, "Files"),
    renderDetailedTestsBlock(ctx.testsDetailed, ctx.tests, "Tests"),
    renderFilesBlock(ctx.docs, "Docs"),
    renderFilesBlock(ctx.configs, "Configs"),
    renderNodesBlock(ctx.graph.nodes, "Graph nodes"),
    `Graph edges: ${ctx.graph.edges.length}.`,
    ctx.git.recentCommits.length === 0
      ? "Recent commits: none."
      : `Recent commits (${ctx.git.recentCommits.length}):\n${ctx.git.recentCommits
          .slice(0, MAX_ITEMS_PER_OUTPUT)
          .map((c) => `  ${c.sha} ${truncate(c.subject, 100)}`)
          .join("\n")}${ctx.git.recentCommits.length > MAX_ITEMS_PER_OUTPUT ? "\n... and more." : ""}`,
    ...ownershipLines,
  ].join("\n\n")
}

export const formatNodesList = (nodes: readonly CodegraphNode[], header: string): string =>
  renderNodesBlock(nodes, header)

export type FormatTestsOutput = {
  tests: readonly CodegraphNode[]
  testsDetailed?: readonly DetailedTest[]
  derivation?: TestMatchDerivation | "none"
  notFound: boolean
  fallbackReason?: string
  staleFiles?: number
}

export const formatTestsOutput = (output: FormatTestsOutput): string => {
  const statusLines: string[] = []
  if (output.notFound) {
    statusLines.push(`No test nodes found for the requested symbol.`)
  } else if (output.derivation) {
    statusLines.push(`Primary derivation: ${output.derivation}`)
  }
  if (output.staleFiles && output.staleFiles > 0) {
    statusLines.push(`${output.staleFiles} file(s) changed since index; run /codegraph-build`)
  }
  const blocks: string[] = []
  if (output.testsDetailed && output.testsDetailed.length > 0) {
    const visible = output.testsDetailed.slice(0, MAX_ITEMS_PER_OUTPUT)
    const lines = visible.map(
      (r) =>
        `${r.node.kind} ${r.node.name} (${r.node.fileID}:${r.node.startLine}-${r.node.endLine}) [${r.derivation}, conf ${r.confidence}]${r.derivation === "substring-low-confidence" ? " — DIAGNOSTIC ONLY, not a confirmed test" : ""}`,
    )
    const remaining = output.testsDetailed.length - visible.length
    const tail = remaining > 0 ? `\n... and ${remaining} more.` : ""
    blocks.push(`Tests (${output.testsDetailed.length}):\n${lines.join("\n")}${tail}`)
  } else {
    blocks.push(renderNodesBlock(output.tests, "Tests"))
  }
  if (output.fallbackReason) {
    blocks.push(`[Fallback: ${output.fallbackReason}]`)
  }
  return [...statusLines, ...blocks].join("\n\n")
}

export const formatOwnership = (owner: string | undefined, count: number): string => {
  if (!owner) {
    return `No owner found for this path (0 commits in the indexed history). If a path is provided, ensure the workspace is a git repository with commit history.`
  }
  return `Owner: ${owner}\nCommits touching this path: ${count}`
}
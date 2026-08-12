export * as RepositoryGatewayFormatter from "./formatter"

import type { RepositoryOperation, RepositoryResult, RepositoryResultItem } from "./types"

// Compact model-facing output for INTELLIGENCE results (plan §28): a short
// header plus a callers-style "path:line" list. No verbose graph narration.

const formatHeader = (operation: RepositoryOperation): string => {
  switch (operation.kind) {
    case "relationship":
      return `${operation.target} ${operation.relation}:`
    case "content":
      return `${operation.path}:`
    case "text_search":
      return `Matches for "${operation.pattern}":`
    case "file_discovery":
      return `Files matching "${operation.pattern}":`
    case "symbol":
      return `Symbols for "${operation.query}":`
    case "structural":
      return `Structural matches for "${operation.query}":`
    case "architecture":
      return `Architecture for "${operation.query}":`
    case "ownership":
      return `Ownership for "${operation.query}":`
  }
}

const formatItem = (item: RepositoryResultItem): string => {
  const line = item.line ?? 1
  const base = `${item.path}:${line}`
  return item.name !== undefined ? `${base} (${item.name})` : base
}

export const format = (operation: RepositoryOperation, result: RepositoryResult): string => {
  const header = formatHeader(operation)
  const lines = result.results.map(formatItem)
  if (lines.length === 0) return `${header}\n\nNo results.`
  return `${header}\n\n${lines.join("\n")}`
}

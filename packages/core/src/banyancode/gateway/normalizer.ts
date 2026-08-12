export * as RepositoryGatewayNormalizer from "./normalizer"

import { Effect } from "effect"
import type { RepositoryOperation, RepositoryRequest } from "./types"

// Maps the raw arguments of a conventional tool call onto a
// RepositoryOperation (plan §2.3). Conventional mapping:
//   read  -> content
//   grep  -> text_search
//   glob  -> file_discovery
// Unknown tools fall back to text_search when the arguments carry a
// pattern-like key, otherwise to content. Never fails.

const firstString = (args: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

const toContent = (request: RepositoryRequest): RepositoryOperation => {
  const path = firstString(request.arguments, ["path", "filePath", "file"]) ?? ""
  return { kind: "content", path }
}

const toTextSearch = (request: RepositoryRequest): RepositoryOperation => {
  const pattern = firstString(request.arguments, ["pattern", "query", "query_string"]) ?? ""
  const path = firstString(request.arguments, ["path", "directory", "cwd"])
  return { kind: "text_search", pattern, ...(path !== undefined ? { paths: [path] } : {}) }
}

const toFileDiscovery = (request: RepositoryRequest): RepositoryOperation => {
  const pattern = firstString(request.arguments, ["pattern", "glob"]) ?? ""
  const path = firstString(request.arguments, ["path", "cwd"])
  return { kind: "file_discovery", pattern, ...(path !== undefined ? { path } : {}) }
}

const normalizePure = (request: RepositoryRequest): RepositoryOperation => {
  switch (request.originalTool) {
    case "read":
      return toContent(request)
    case "grep":
      // Identifier-shaped patterns could route to `symbol`; Phase 0 keeps it
      // simple — grep always normalizes to text_search.
      return toTextSearch(request)
    case "glob":
      return toFileDiscovery(request)
    default: {
      const pattern = firstString(request.arguments, ["pattern", "query"])
      return pattern !== undefined ? toTextSearch(request) : toContent(request)
    }
  }
}

export const normalize = (request: RepositoryRequest): Effect.Effect<RepositoryOperation, never, never> =>
  Effect.succeed(normalizePure(request))

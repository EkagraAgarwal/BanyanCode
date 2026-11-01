// MCP read-only code-intelligence tools.
//
// Thin adapter over the `banyancode.*` RPCs — no business logic lives here.
// Every tool forwards to the plugin through the generated Promise client's
// `rpc` surface (see ./rpc.ts):
//
//   banyan_code_find    -> banyancode.intel.codeFind
//   banyan_repo         -> banyancode.intel.{query,explain,impact,trace,tests,
//                                          symbols,relationships,ownership,slice}
//   banyan_change_check -> banyancode.intel.{preflight,blastRadius}
//   banyan_codegraph    -> banyancode.codegraph.{status,build,staleness}
//
// v1 names and parameters are preserved (`intent`/`target`/`limit`, the
// `op`-selected tools, `action`/`depth` for change checks). Input schemas are
// zod (MCP-native): the SDK serializes plain JSON bodies, so zod shapes also
// sidestep the Effect `$ref` array-decoding hazard documented in AGENTS.md.

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/server"
import { assertInsideRoot } from "./paths"
import { CodeToolOutputSchema, UNTRUSTED_NOTE, errorResult, invalidArguments, okResult } from "./output"
import type { McpToolResult } from "./output"
import { isRpcUnavailable, messageOf, type RpcCaller } from "./rpc"
import { Definition as CodegraphRpc } from "@banyancode/plugin/rpc/codegraph"
import { Definition as IntelRpc } from "@banyancode/plugin/rpc/intel"

export type CodeToolsDeps = {
  rpc: RpcCaller
  cwd: string
  outputChars?: number
}

export const CodeFindToolName = "banyan_code_find" as const
export const RepoToolName = "banyan_repo" as const
export const ChangeCheckToolName = "banyan_change_check" as const
export const CodegraphToolName = "banyan_codegraph" as const

export const CodeToolNames = [ChangeCheckToolName, CodeFindToolName, CodegraphToolName, RepoToolName] as const
export type CodeToolName = (typeof CodeToolNames)[number]

export const RepoOps = [
  "query",
  "explain",
  "impact",
  "trace",
  "tests",
  "symbols",
  "relationships",
  "ownership",
  "slice",
] as const
export type RepoOp = (typeof RepoOps)[number]

export const ChangeCheckOps = ["preflight", "blast_radius"] as const
export type ChangeCheckOp = (typeof ChangeCheckOps)[number]

export const CodegraphOps = ["status", "build", "staleness"] as const
export type CodegraphOp = (typeof CodegraphOps)[number]

// Graph nodes carry their whole source body in `code`; a single large node used
// to eat the output budget and push every other match into truncation. Matches
// carry path + startLine/endLine, so a short head is enough to recognize the
// symbol; read the file for the full body.
const CODE_SNIPPET_CHARS = 600
const clampCode = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(clampCode)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) =>
      key === "code" && typeof entry === "string" && entry.length > CODE_SNIPPET_CHARS
        ? [
            key,
            `${entry.slice(0, CODE_SNIPPET_CHARS)}…[${entry.length - CODE_SNIPPET_CHARS} more chars; read the file range]`,
          ]
        : [key, clampCode(entry)],
    ),
  )
}

// Guard is validation-only: the server resolves the path against the indexed
// workspace. Returns the absolute resolved path when it stays inside the root,
// otherwise a PATH_ESCAPE tool error for the `..` / absolute / symlink escape.
const guardedPath = (cwd: string, input: string): { path: string } | { error: McpToolResult } => {
  try {
    return { path: assertInsideRoot(cwd, input) }
  } catch (error) {
    return {
      error: errorResult("PATH_ESCAPE", error instanceof Error ? error.message : `path escapes project root: ${input}`),
    }
  }
}

const invoke = async (deps: CodeToolsDeps, namespace: string, run: () => Promise<unknown>): Promise<McpToolResult> => {
  try {
    return okResult(clampCode(await run()), deps.outputChars)
  } catch (error) {
    if (isRpcUnavailable(error)) {
      return errorResult(
        "RPC_UNAVAILABLE",
        `${namespace} is not registered on this server (${messageOf(error)}); load the BanyanCode plugin in banyancode.json`,
      )
    }
    return errorResult("UPSTREAM_ERROR", `request failed: ${messageOf(error)}`)
  }
}

// Closed value sets are native z.enums: they serialize to an `enum` keyword in
// the advertised JSON schema and keep inference shallow.
const CodeFindInput = z.object({
  intent: z
    .enum(["definition", "callers", "dependents", "impact", "find_file"])
    .describe(
      "Search kind: definition locates the symbol, callers/dependents/impact traverse it, find_file locates a file.",
    ),
  target: z.string().min(1).max(512).describe("Symbol name (e.g. 'MemoryRepo.update'), filename, or node ID."),
  includeKeywordFallback: z
    .boolean()
    .optional()
    .describe("Fallback to substring matching when the exact symbol is absent. Defaults to true."),
  limit: z.number().int().min(1).max(500).optional().describe("Max results. Defaults to 50."),
})
type CodeFindArgs = z.infer<typeof CodeFindInput>

const RepoInput = z.object({
  op: z
    .enum(["query", "explain", "impact", "trace", "tests", "symbols", "relationships", "ownership", "slice"])
    .describe("query|explain|impact|trace|tests|symbols|relationships|ownership|slice."),
  query: z.string().min(1).max(1024).optional().describe("Free-text query (query, symbols)."),
  symbol: z.string().min(1).max(512).optional().describe("Symbol name (explain, trace, tests)."),
  path: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe("File path inside the project root (impact, relationships, ownership)."),
  nodeID: z.string().min(1).max(512).optional().describe("Codegraph node ID (relationships)."),
  focus: z.string().min(1).max(512).optional().describe("Symbol to explain (slice)."),
  depth: z.number().int().min(1).max(8).optional().describe("Traversal depth (trace, relationships)."),
  limit: z.number().int().min(1).max(500).optional().describe("Max results (query, trace, symbols)."),
})
type RepoArgs = z.infer<typeof RepoInput>

const ChangeCheckInput = z.object({
  op: z
    .enum(["preflight", "blast_radius"])
    .describe("preflight for the full decision report, blast_radius for counts only."),
  target: z.string().min(1).max(512).describe("Symbol name or node ID the edit targets."),
  action: z
    .enum(["rename", "modify", "delete"])
    .optional()
    .describe("Planned edit kind (preflight only). Defaults to modify."),
  depth: z
    .number()
    .int()
    .min(1)
    .max(8)
    .optional()
    .describe("Traversal depth preview (preflight depth / blast_radius maxDepth)."),
})
type ChangeCheckArgs = z.infer<typeof ChangeCheckInput>

const CodegraphInput = z.object({
  op: z
    .enum(["status", "build", "staleness"])
    .describe("status reads persisted readiness, build kicks off a background index, staleness reports drift."),
  root: z.string().min(1).max(512).optional().describe("Workspace root. Defaults to the project root."),
  force: z.boolean().optional().describe("Force a full reindex (build only)."),
})
type CodegraphArgs = z.infer<typeof CodegraphInput>

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const metaFor = (deps: CodeToolsDeps): Record<string, unknown> => ({
  "anthropic/maxResultSizeChars": deps.outputChars ?? 8000,
})

export function registerCodeTools(mcp: McpServer, deps: CodeToolsDeps): void {
  // Registration order is alphabetical so tools/list is deterministic.
  mcp.registerTool(
    ChangeCheckToolName,
    {
      title: "Change safety check",
      description: `Check whether an edit is safe before applying it (banyancode.intel.preflight / blastRadius, op-selected). ${UNTRUSTED_NOTE}`,
      inputSchema: ChangeCheckInput,
      outputSchema: CodeToolOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: metaFor(deps),
    },
    async (args: ChangeCheckArgs): Promise<McpToolResult> => {
      const intel = deps.rpc(IntelRpc)
      if (args.op === "preflight") {
        return invoke(deps, "banyancode.intel.preflight", () =>
          intel.preflight(
            {
              target: args.target,
              action: args.action ?? "modify",
              ...(args.depth !== undefined ? { depth: args.depth } : {}),
            },
            { location: { directory: deps.cwd } },
          ),
        )
      }
      return invoke(deps, "banyancode.intel.blastRadius", () =>
        intel.blastRadius(
          {
            target: args.target,
            ...(args.depth !== undefined ? { maxDepth: args.depth } : {}),
          },
          { location: { directory: deps.cwd } },
        ),
      )
    },
  )

  mcp.registerTool(
    CodeFindToolName,
    {
      title: "Code symbol finder",
      description: `Symbol locator across the codebase graph (banyancode.intel.codeFind). ${UNTRUSTED_NOTE}`,
      inputSchema: CodeFindInput,
      outputSchema: CodeToolOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: metaFor(deps),
    },
    async (args: CodeFindArgs): Promise<McpToolResult> => {
      const intel = deps.rpc(IntelRpc)
      return invoke(deps, "banyancode.intel.codeFind", () =>
        intel.codeFind(
          {
            intent: args.intent,
            target: args.target,
            includeKeywordFallback: args.includeKeywordFallback ?? true,
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          },
          { location: { directory: deps.cwd } },
        ),
      )
    },
  )

  // No readOnlyHint: op=build starts a background index (a state change).
  mcp.registerTool(
    CodegraphToolName,
    {
      title: "Codegraph index status and builds",
      description: `Codegraph index status, builds and staleness (banyancode.codegraph.{status,build,staleness}, op-selected). ${UNTRUSTED_NOTE}`,
      inputSchema: CodegraphInput,
      outputSchema: CodeToolOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: metaFor(deps),
    },
    async (args: CodegraphArgs): Promise<McpToolResult> => {
      // The codegraph namespace is location-scoped; an explicit absolute root
      // keeps `--cwd` authoritative even when the server runs in $HOME.
      const guarded = guardedPath(deps.cwd, args.root ?? ".")
      if ("error" in guarded) return guarded.error
      const codegraph = deps.rpc(CodegraphRpc)
      const location = { location: { directory: deps.cwd } }
      if (args.op === "status") {
        return invoke(deps, "banyancode.codegraph.status", () => codegraph.status({ root: guarded.path }, location))
      }
      if (args.op === "staleness") {
        return invoke(deps, "banyancode.codegraph.staleness", () =>
          codegraph.staleness({ root: guarded.path }, location),
        )
      }
      return invoke(deps, "banyancode.codegraph.build", () =>
        codegraph.build(
          {
            root: guarded.path,
            ...(args.force !== undefined ? { force: args.force } : {}),
          },
          location,
        ),
      )
    },
  )

  mcp.registerTool(
    RepoToolName,
    {
      title: "Repository intelligence",
      description: `Repository intelligence: query, explain, impact, trace, tests, symbols, relationships, ownership, and architectural slices (banyancode.intel.*, op-selected). ${UNTRUSTED_NOTE}`,
      inputSchema: RepoInput,
      outputSchema: CodeToolOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: metaFor(deps),
    },
    async (args: RepoArgs): Promise<McpToolResult> => {
      const intel = deps.rpc(IntelRpc)
      const location = { location: { directory: deps.cwd } }
      switch (args.op) {
        case "query": {
          const query = args.query
          if (query === undefined || query === "") return invalidArguments(`banyan_repo op "query" requires "query".`)
          const limit = args.limit
          return invoke(deps, "banyancode.intel.query", () =>
            intel.query({ query, ...(limit !== undefined ? { limit } : {}) }, location),
          )
        }
        case "explain": {
          const symbol = args.symbol
          if (symbol === undefined || symbol === "") return invalidArguments(`banyan_repo op "explain" requires "symbol".`)
          return invoke(deps, "banyancode.intel.explain", () => intel.explain({ symbol }, location))
        }
        case "impact": {
          const input = args.path
          if (input === undefined || input === "") return invalidArguments(`banyan_repo op "impact" requires "path".`)
          const guarded = guardedPath(deps.cwd, input)
          if ("error" in guarded) return guarded.error
          return invoke(deps, "banyancode.intel.impact", () => intel.impact({ path: guarded.path }, location))
        }
        case "trace": {
          const symbol = args.symbol
          if (symbol === undefined || symbol === "") return invalidArguments(`banyan_repo op "trace" requires "symbol".`)
          const depth = args.depth
          const limit = args.limit
          return invoke(deps, "banyancode.intel.trace", () =>
            intel.trace(
              {
                symbol,
                ...(depth !== undefined ? { depth } : {}),
                ...(limit !== undefined ? { limit } : {}),
              },
              location,
            ),
          )
        }
        case "tests": {
          const symbol = args.symbol
          if (symbol === undefined || symbol === "") return invalidArguments(`banyan_repo op "tests" requires "symbol".`)
          return invoke(deps, "banyancode.intel.tests", () => intel.tests({ symbol }, location))
        }
        case "symbols": {
          const query = args.query
          if (query === undefined || query === "")
            return invalidArguments(`banyan_repo op "symbols" requires "query".`)
          const limit = args.limit
          return invoke(deps, "banyancode.intel.symbols", () =>
            intel.symbols({ query, ...(limit !== undefined ? { limit } : {}) }, location),
          )
        }
        case "relationships": {
          const nodeID = args.nodeID
          const input = args.path
          if (nodeID === undefined && input === undefined) {
            return invalidArguments(`banyan_repo op "relationships" requires "nodeID" or "path".`)
          }
          let resolvedPath: string | undefined
          if (input !== undefined && input !== "") {
            const guarded = guardedPath(deps.cwd, input)
            if ("error" in guarded) return guarded.error
            resolvedPath = guarded.path
          }
          const depth = args.depth
          return invoke(deps, "banyancode.intel.relationships", () =>
            intel.relationships(
              {
                ...(nodeID !== undefined ? { nodeID } : {}),
                ...(resolvedPath !== undefined ? { path: resolvedPath } : {}),
                ...(depth !== undefined ? { depth } : {}),
              },
              location,
            ),
          )
        }
        case "ownership": {
          const input = args.path
          if (input === undefined || input === "") return invalidArguments(`banyan_repo op "ownership" requires "path".`)
          const guarded = guardedPath(deps.cwd, input)
          if ("error" in guarded) return guarded.error
          return invoke(deps, "banyancode.intel.ownership", () => intel.ownership({ path: guarded.path }, location))
        }
        case "slice": {
          const focus = args.focus
          if (focus === undefined || focus === "") return invalidArguments(`banyan_repo op "slice" requires "focus".`)
          return invoke(deps, "banyancode.intel.slice", () => intel.slice({ focus }, location))
        }
        default:
          return invalidArguments(`unknown banyan_repo op: ${String((args as { op?: unknown }).op)}`)
      }
    },
  )
}

export * as McpCodeTools from "./tools-code"

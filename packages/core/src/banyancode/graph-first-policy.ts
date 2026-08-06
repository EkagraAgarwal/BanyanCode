import type { GraphFirstMode, GraphOutcome } from "./types"

/**
 * Graph-first routing policy state shared by the session tool wrapper
 * (`packages/opencode/src/session/tools.ts`) and the policy renderer.
 *
 * `BANYANCODE_GRAPH_FIRST_MODE=off|advisory|enforce` gates the per-turn
 * redirect in the common session tool wrapper. `off` (the default) changes
 * nothing; `advisory` appends a structured redirect note to early
 * source-code `read`/`grep`/`glob` results without blocking them; `enforce`
 * returns only the redirect until the model attempts a graph/repository
 * tool in the same turn. Arbitrary `bash` is observed but never blocked —
 * safe classification of a bash invocation is unreliable.
 */

export const GRAPH_FIRST_MODE_ENV = "BANYANCODE_GRAPH_FIRST_MODE"

export const graphFirstMode = (): GraphFirstMode => {
  const raw = process.env[GRAPH_FIRST_MODE_ENV]
  return raw === "advisory" ? "advisory" : raw === "enforce" ? "enforce" : "off"
}

/**
 * Tool ids that count as a "task-specific graph attempt" for the per-turn
 * redirect state. Mirrors the public graph/repository/edit-decision/repo-map
 * families the policy routes to. A session-start `banyan_repo_map` counts —
 * it is still a task-specific graph attempt for THIS turn.
 */
export const GRAPH_ATTEMPT_TOOL_IDS: ReadonlySet<string> = new Set([
  "codegraph_build",
  "codegraph_remove",
  "code_find",
  "repository_query",
  "repository_explain",
  "repository_impact",
  "repository_trace",
  "repository_tests",
  "blast_radius",
  "preflight",
  "safe_rename",
  "edit_plan",
  "banyan_repo_map",
  "banyan_tool_search",
  "banyan_test",
])

/** Source-code reads and code-targeted searches the policy redirects. */
export const SOURCE_READ_TOOL_IDS: ReadonlySet<string> = new Set(["read", "grep", "glob"])

/** Bash is observed but never blocked — safe classification is unreliable. */
export const BASH_TOOL_IDS: ReadonlySet<string> = new Set(["bash"])

export const isGraphAttempt = (toolID: string): boolean => GRAPH_ATTEMPT_TOOL_IDS.has(toolID)
export const isSourceRead = (toolID: string): boolean => SOURCE_READ_TOOL_IDS.has(toolID)

/**
 * File extensions that are unambiguously source code. Used to honor the
 * policy's non-code-artifact exemption for `read` calls: reading a config,
 * doc, lockfile, or generated artifact is allowed before any graph attempt.
 */
const CODE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "cs",
  "rb",
  "php",
  "swift",
  "scala",
  "vue",
  "svelte",
  "astro",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "graphql",
  "css",
  "scss",
  "less",
  "html",
  "xml",
  "jsonc",
  "toml",
  "yaml",
  "yml",
  "proto",
  "zig",
  "lua",
  "ex",
  "exs",
])

export interface GraphRedirect {
  readonly tool: string
  readonly hint: string
}

/**
 * The single graph/repository tool to route a pre-graph-attempt source read
 * to. `args` is the raw tool input; for `read` the target extension decides
 * whether the non-code-artifact exemption applies.
 */
export const redirectFor = (toolID: string, args: Record<string, unknown>): GraphRedirect | undefined => {
  switch (toolID) {
    case "read": {
      const filePath = typeof args.filePath === "string" ? args.filePath : ""
      const ext = filePath.includes(".") ? filePath.split(".").pop()?.toLowerCase() ?? "" : ""
      if (ext !== "" && !CODE_FILE_EXTENSIONS.has(ext)) return undefined
      return {
        tool: "code_find",
        hint:
          "`code_find(intent='find_file'|'definition'|'callers'|'dependents')` " +
          "locates the file or symbol the read targets and returns file:line ranges.",
      }
    }
    case "grep":
      return {
        tool: "repository_query",
        hint:
          "`repository_query(query=...)` searches indexed symbols and files; " +
          "`code_find(intent='definition')` finds a symbol by name.",
      }
    case "glob":
      return {
        tool: "banyan_repo_map",
        hint: "`banyan_repo_map` returns the workspace outline (packages, entry points, per-file symbols).",
      }
    default:
      return undefined
  }
}

/**
 * Classify a graph/repository tool result for adoption telemetry. This is a
 * coarse text heuristic over the rendered output; the ordered checks match
 * the fallback vocabulary the policy and repository tools use.
 */
export const graphOutcome = (text: string): GraphOutcome => {
  const haystack = text.toLowerCase()
  if (
    /not[ -]found|did you mean|couldn'?t find|could not find|no (symbol|file|definition|callers?|dependents?) (found|exists)/.test(
      haystack,
    )
  )
    return "not-found"
  if (/degraded/.test(haystack)) return "degraded"
  if (/stale/.test(haystack)) return "stale"
  if (/fallback/.test(haystack)) return "fallback"
  if (/(^|[\s.])empty\b|no result|0 results?/.test(haystack)) return "empty"
  if (/fail(ed|ure)?|error/.test(haystack)) return "failed"
  return "ok"
}

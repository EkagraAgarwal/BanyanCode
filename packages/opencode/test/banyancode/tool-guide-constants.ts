/**
 * Single-source-of-truth constants for the BanyanCode tool guide regression
 * suite. Every test file in this PR imports from here so a tool that gets
 * renamed or moved only needs to be touched in one place.
 *
 * The values are aligned with `BANYAN_TOOL_IDS` /
 * `TOOL_FAMILIES` in `packages/core/src/banyancode/codegraph-system-source.ts`
 * and the built-in permission rulesets in
 * `packages/opencode/src/agent/agent.ts`.
 */

// LLM-facing tools that MUST appear in every rendered guide (the 12 public
// tool ids that the model can call directly).
export const REQUIRED_TOOLS = [
  "codegraph_build",
  "codegraph_remove",
  "code_find",
  "repository_query",
  "repository_explain",
  "repository_trace",
  "repository_tests",
  "blast_radius",
  "preflight",
  "safe_rename",
  "edit_plan",
  "websearch_free",
] as const

// Internal-only helpers that MUST NEVER appear in the rendered guide.
export const FORBIDDEN_TOOLS = [
  "codegraph_query",
  "codegraph_callers",
  "codegraph_dependents",
  "codegraph_search",
  "codegraph_find_async",
  "codegraph_find_recursive",
  "codegraph_find_http_routes",
  "codegraph_find_overrides",
  "codegraph_find_implementations",
  "repository_symbols",
  "repository_relationships",
  "repository_ownership",
] as const

// Strong-model-only tools — only emitted when the upstream consumer
// (ToolRegistry) has decided the model is strong enough to see them.
export const ADVANCED_TOOLS = ["codegraph_impact", "repository_impact"] as const

// Model strengths mirror `tool-visibility.test.ts:117-128` + the addition
// of `minimax-M3` (this product's default model).
export const STRONG_MODEL_IDS = [
  "claude-opus-4",
  "claude-sonnet-4",
  "gpt-5",
  "gpt-5-mini",
  "o1",
  "o3",
  "claude-3-5-sonnet-20241022",
  "claude-3-7-sonnet-20241022",
] as const

export const WEAK_MODEL_IDS = ["minimax-M3", "claude-3-5-haiku-20240307"] as const

// 8 provider-prompt files consumed by `SystemPrompt.provider(model)`.
// The order matches the dispatch in `packages/opencode/src/session/system.ts`.
export const PROVIDER_PROMPT_FILES = [
  ["anthropic", "anthropic.txt"],
  ["beast", "beast.txt"],
  ["codex", "codex.txt"],
  ["default", "default.txt"],
  ["gemini", "gemini.txt"],
  ["gpt", "gpt.txt"],
  ["kimi", "kimi.txt"],
  ["trinity", "trinity.txt"],
] as const

// 8 built-in agents that the BanyanCode tool guide policy must cover.
export const BUILTIN_AGENT_NAMES = [
  "build",
  "plan",
  "general",
  "explore",
  "coder",
  "scout",
  "researcher",
  "orchestrator",
] as const
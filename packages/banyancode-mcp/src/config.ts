// `banyancode_mcp_server` config for `banyancode mcp`.
//
// v2's host config normalizer drops unknown `banyancode_*` keys (spike result,
// `specs/banyancode/v2-migration-plan.md`), so — exactly like the BanyanCode
// plugin — this package reads and validates `banyancode.json` itself. Unknown
// keys are ignored; a file that fails to parse degrades to reject-everything
// defaults instead of blocking the server.

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { z } from "zod"

export const AutonomyRuleSchema = z.object({
  action: z.string().min(1).default("*"),
  resource: z.string().min(1).default("*"),
  effect: z.enum(["allow", "deny", "ask"]),
})
export type AutonomyRule = z.infer<typeof AutonomyRuleSchema>

export const AutonomyProfileSchema = z.object({
  description: z.string().optional(),
  rules: z.array(AutonomyRuleSchema).default([]),
})
export type AutonomyProfile = z.infer<typeof AutonomyProfileSchema>

export const AutonomyConfigSchema = z.object({
  /** Profile used when `banyan_task_start` omits `autonomy`. */
  default: z.string().optional(),
  /**
   * How long a permission ask may sit unanswered before the engine applies
   * the profile's allow/deny decision itself. `0` disables auto-answer.
   */
  auto_answer_after_seconds: z.number().int().min(0).max(86_400).default(120),
  profiles: z.record(z.string(), AutonomyProfileSchema).default({}),
})
export type AutonomyConfig = z.infer<typeof AutonomyConfigSchema>

export const McpServerSchema = z.object({
  default_agent: z.string().min(1).max(64).optional(),
  default_model: z.string().min(1).max(256).optional(),
  permission: z.enum(["reject", "edits"]).optional(),
  max_concurrent_tasks: z.number().int().min(1).max(32).optional(),
  task_budget_usd: z.number().min(0).max(1000).optional(),
  result_max_tokens: z.number().int().min(100).max(32_000).optional(),
  needs_input_timeout_seconds: z.number().int().min(60).max(86_400).optional(),
  output_max_chars: z.number().int().min(1000).max(500_000).optional(),
  allowed_agents: z.array(z.string().min(1).max(64)).optional(),
  allowed_models: z.array(z.string().min(1).max(256)).optional(),
  tools: z.array(z.string().min(1).max(64)).optional(),
  /** Default isolation for `banyan_task_start` when the call omits `worktree`. */
  worktree: z.enum(["new", "shared"]).optional(),
  autonomy: AutonomyConfigSchema.optional(),
})
export type McpServerConfig = z.infer<typeof McpServerSchema>

export const BanyanConfigFileSchema = z
  .object({
    banyancode_mcp_server: McpServerSchema.optional(),
  })
  .passthrough()

export type ResolvedConfig = {
  configPath?: string
  mcp: McpServerConfig
  autonomy: AutonomyConfig
  permission: "reject" | "edits" | "yolo"
  maxConcurrentTasks: number
  resultMaxTokens: number
  needsInputTimeoutSeconds: number
  outputMaxChars: number
  taskBudgetUsd: number
  worktree: "new" | "shared"
  defaultAgent?: string
  defaultModel?: string
  allowedAgents?: string[]
  allowedModels?: string[]
  toolGroups?: string[]
}

export const DEFAULT_MAX_CONCURRENT_TASKS = 4
export const DEFAULT_RESULT_MAX_TOKENS = 1500
export const DEFAULT_NEEDS_INPUT_TIMEOUT_SECONDS = 600
export const DEFAULT_OUTPUT_MAX_CHARS = 8_000
export const DEFAULT_TASK_BUDGET_USD = 5
export const DEFAULT_AUTO_ANSWER_AFTER_SECONDS = 120

export const TOOL_GROUPS = ["task", "code"] as const
export type ToolGroup = (typeof TOOL_GROUPS)[number]

export class InvalidConfigError extends Error {
  readonly code = "INVALID_CONFIG" as const
  constructor(message: string) {
    super(message)
    this.name = "InvalidConfigError"
  }
}

const assertToolGroups = (groups: readonly string[] | undefined): void => {
  if (groups === undefined) return
  const unknown = groups.filter((group) => !(TOOL_GROUPS as readonly string[]).includes(group))
  if (unknown.length === 0) return
  throw new InvalidConfigError(
    `unknown tool group${unknown.length === 1 ? "" : "s"} ${unknown.map((group) => `"${group}"`).join(", ")}; ` +
      `expected one of: ${TOOL_GROUPS.join(", ")}`,
  )
}

// Strip `//` and `/* */` comments plus trailing commas without touching
// string contents. banyancode.json is JSONC by convention.
export function stripJsonc(text: string): string {
  let out = ""
  let index = 0
  let inString = false
  let escaped = false
  while (index < text.length) {
    const char = text[index]!
    const next = text[index + 1]
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      index += 1
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      index += 1
      continue
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1
      index += 2
      continue
    }
    out += char
    index += 1
  }
  // Trailing commas: `,` followed by whitespace then `}` or `]`.
  return out.replace(/,(\s*[}\]])/g, "$1")
}

const CANDIDATE_NAMES = ["banyancode.json", "banyancode.jsonc"] as const

// Search order: explicit path, $BANYANCODE_CONFIG, the cwd chain, the global
// BanyanCode config dir. `walkUp` mirrors the host config discovery so a
// subdirectory cwd still finds the project file.
export function findConfigPath(input: {
  cwd: string
  explicit?: string
  env?: NodeJS.ProcessEnv
  home?: string
}): string | undefined {
  const env = input.env ?? process.env
  if (input.explicit !== undefined) return path.resolve(input.cwd, input.explicit)
  const fromEnv = env["BANYANCODE_CONFIG"]
  if (fromEnv !== undefined && fromEnv !== "") return path.resolve(input.cwd, fromEnv)
  const fromDir = env["BANYANCODE_CONFIG_DIR"]
  if (fromDir !== undefined && fromDir !== "") {
    for (const name of CANDIDATE_NAMES) {
      const candidate = path.join(fromDir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  let directory = path.resolve(input.cwd)
  while (true) {
    for (const name of CANDIDATE_NAMES) {
      const candidate = path.join(directory, name)
      if (existsSync(candidate)) return candidate
    }
    const nested = path.join(directory, ".banyancode")
    for (const name of CANDIDATE_NAMES) {
      const candidate = path.join(nested, name)
      if (existsSync(candidate)) return candidate
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const home = input.home ?? homedir()
  for (const name of CANDIDATE_NAMES) {
    const candidate = path.join(home, ".config", "banyancode", name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export function readConfigFile(file: string): McpServerConfig {
  const text = readFileSync(file, "utf8")
  const parsed = JSON.parse(stripJsonc(text)) as unknown
  const config = BanyanConfigFileSchema.parse(parsed)
  return config.banyancode_mcp_server ?? {}
}

export type ConfigOverrides = {
  cwd: string
  configPath?: string
  allowYolo?: boolean
  permission?: "reject" | "edits" | "yolo"
  maxConcurrentTasks?: number
  toolGroups?: string[]
  defaultAgent?: string
  defaultModel?: string
  env?: NodeJS.ProcessEnv
  home?: string
}

// Stored config can never express yolo. The only paths there are the explicit
// `--allow-yolo` process gate and the per-call CLI override, and both must
// still pass `assertYoloAllowed` at boot and per task start.
export function resolvePermission(input: {
  stored?: "reject" | "edits"
  override?: "reject" | "edits" | "yolo"
  allowYolo: boolean
}): "reject" | "edits" | "yolo" {
  if (input.override !== undefined) return input.override
  if (input.allowYolo) return "yolo"
  if (input.stored === "edits") return "edits"
  return "reject"
}

const positiveInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === "") return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

export function resolveConfig(overrides: ConfigOverrides): ResolvedConfig {
  const env = overrides.env ?? process.env
  const file = findConfigPath({
    cwd: overrides.cwd,
    ...(overrides.configPath !== undefined ? { explicit: overrides.configPath } : {}),
    env,
    ...(overrides.home !== undefined ? { home: overrides.home } : {}),
  })
  let stored: McpServerConfig = {}
  if (file !== undefined) {
    try {
      stored = readConfigFile(file)
    } catch {
      stored = {}
    }
  }
  const permission = resolvePermission({
    stored: stored.permission,
    ...(overrides.permission !== undefined ? { override: overrides.permission } : {}),
    allowYolo: overrides.allowYolo ?? readAllowYoloEnv(env),
  })
  const autonomy: AutonomyConfig = {
    // v1 `--permission edits|yolo` granted those rights directly, so they pick the matching profile
    // unless banyancode.json names one. `reject` keeps the default, which asks the caller.
    default:
      stored.autonomy?.default ??
      (permission === "edits" ? "trusted" : permission === "yolo" ? "yolo" : undefined),
    auto_answer_after_seconds:
      stored.autonomy?.auto_answer_after_seconds ?? DEFAULT_AUTO_ANSWER_AFTER_SECONDS,
    profiles: stored.autonomy?.profiles ?? {},
  }
  const maxConcurrentTasks =
    overrides.maxConcurrentTasks ??
    positiveInt(env["BANYANCODE_MCP_MAX_TASKS"]) ??
    stored.max_concurrent_tasks ??
    DEFAULT_MAX_CONCURRENT_TASKS
  const outputMaxChars =
    positiveInt(env["BANYANCODE_MCP_OUTPUT_CHARS"]) ?? stored.output_max_chars ?? DEFAULT_OUTPUT_MAX_CHARS
  const resolved: ResolvedConfig = {
    ...(file !== undefined ? { configPath: file } : {}),
    mcp: stored,
    autonomy,
    permission,
    maxConcurrentTasks: Math.max(1, Math.min(32, maxConcurrentTasks)),
    resultMaxTokens: stored.result_max_tokens ?? DEFAULT_RESULT_MAX_TOKENS,
    needsInputTimeoutSeconds: stored.needs_input_timeout_seconds ?? DEFAULT_NEEDS_INPUT_TIMEOUT_SECONDS,
    outputMaxChars: Math.max(1000, outputMaxChars),
    taskBudgetUsd: stored.task_budget_usd ?? DEFAULT_TASK_BUDGET_USD,
    worktree: stored.worktree ?? "shared",
  }
  const defaultAgent = overrides.defaultAgent ?? stored.default_agent
  if (defaultAgent !== undefined) resolved.defaultAgent = defaultAgent
  const defaultModel = overrides.defaultModel ?? stored.default_model
  if (defaultModel !== undefined) resolved.defaultModel = defaultModel
  if (stored.allowed_agents !== undefined) resolved.allowedAgents = [...stored.allowed_agents]
  if (stored.allowed_models !== undefined) resolved.allowedModels = [...stored.allowed_models]
  const toolGroups = overrides.toolGroups ?? stored.tools
  assertToolGroups(toolGroups)
  if (toolGroups !== undefined) resolved.toolGroups = [...toolGroups]
  return resolved
}

export function readAllowYoloEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["BANYANCODE_MCP_ALLOW_YOLO"]?.toLowerCase()
  return raw === "1" || raw === "true"
}

export * as McpConfig from "./config"

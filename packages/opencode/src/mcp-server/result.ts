// Compact result builder for MCP delegation (Phase 1).
//
// Builds the bounded summary returned by `banyan_task_result`. The bound
// (default ~1.5K tokens, configurable) is what keeps the caller's usage low:
// the caller gets file +/- counts, verification outcome, open questions and
// todos, cost/tokens and memory refs — not the subagents' full transcripts.
//
// Token accounting uses a ~4 chars/token estimate, matching the rough bound
// in specs/banyancode/mcp-server-plan.md. Patch content is only included
// when detail is "diff"; "summary" carries counts alone.

export const DEFAULT_RESULT_MAX_TOKENS = 1500

export type ResultDetail = "summary" | "diff" | "transcript"

export interface DiffFileInput {
  path: string
  additions: number
  deletions: number
  patch?: string
}

export interface VerificationInput {
  kind: string
  passed: boolean
  counts?: string
  failures?: string[]
}

export interface TodoInput {
  title: string
  status: string
}

export interface OpenQuestionInput {
  requestID: string
  question: string
}

export interface MemoryEntryInput {
  id: string
  title?: string
}

export interface CompactResultInput {
  task_id: string
  status: string
  finalMessage?: string
  diffFiles?: DiffFileInput[]
  verification?: VerificationInput
  todos?: TodoInput[]
  openQuestions?: OpenQuestionInput[]
  cost?: number
  tokensByModel?: Record<string, { input: number; output: number }>
  subagentCount?: number
  memory?: MemoryEntryInput[]
  worktree?: string
}

export interface CompactResult {
  task_id: string
  status: string
  summary: string
  truncated: boolean
  filesChanged: Array<{ path: string; additions: number; deletions: number; patch?: string }>
  totalAdditions: number
  totalDeletions: number
  verification?: VerificationInput
  todos?: TodoInput[]
  openQuestions?: OpenQuestionInput[]
  cost?: number
  tokensByModel?: Record<string, { input: number; output: number }>
  subagentCount?: number
  memory?: MemoryEntryInput[]
  worktree?: string
  tokens: number
}

export interface BuildResultOptions {
  maxTokens?: number
  detail?: ResultDetail
}

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

const TRUNCATION_MARKER = "\n…[truncated]"

function truncateToTokens(text: string, budgetTokens: number): { text: string; truncated: boolean } {
  if (budgetTokens <= 0) return { text: "", truncated: text.length > 0 }
  const budgetChars = budgetTokens * 4 - TRUNCATION_MARKER.length
  if (text.length <= budgetTokens * 4) return { text, truncated: false }
  if (budgetChars <= 0) return { text: "", truncated: true }
  return { text: text.slice(0, budgetChars) + TRUNCATION_MARKER, truncated: true }
}

export function summarizeDiff(files: DiffFileInput[]): { totalAdditions: number; totalDeletions: number } {
  let totalAdditions = 0
  let totalDeletions = 0
  for (const file of files) {
    totalAdditions += file.additions
    totalDeletions += file.deletions
  }
  return { totalAdditions, totalDeletions }
}

function renderFileLine(file: DiffFileInput, includePatch: boolean): string {
  const head = `${file.path} +${file.additions}/-${file.deletions}`
  if (!includePatch || !file.patch) return head
  return `${head}\n${file.patch}`
}

export function buildCompactResult(input: CompactResultInput, opts: BuildResultOptions = {}): CompactResult {
  const maxTokens = opts.maxTokens ?? DEFAULT_RESULT_MAX_TOKENS
  const detail = opts.detail ?? "summary"
  const includePatch = detail === "diff"

  const diffFiles = input.diffFiles ?? []
  const { totalAdditions, totalDeletions } = summarizeDiff(diffFiles)

  // Fixed overhead first: structured fields outside the free-text summary.
  const overhead =
    estimateTokens(input.task_id) +
    estimateTokens(input.status) +
    estimateTokens(JSON.stringify(input.verification ?? null)) +
    estimateTokens(JSON.stringify(input.todos ?? [])) +
    estimateTokens(JSON.stringify(input.openQuestions ?? [])) +
    estimateTokens(JSON.stringify(input.tokensByModel ?? {})) +
    estimateTokens(JSON.stringify(input.memory ?? [])) +
    estimateTokens(input.worktree ?? "") +
    // one line per file entry without patch content
    diffFiles.reduce((sum, file) => sum + estimateTokens(renderFileLine(file, false) + "\n"), 0)

  const summaryBudget = Math.max(0, maxTokens - overhead)
  const finalMessage = input.finalMessage ?? ""
  const { text: summary, truncated: summaryTruncated } = truncateToTokens(finalMessage, summaryBudget)

  let filesChanged: CompactResult["filesChanged"] = []
  let patchTruncated = false
  if (includePatch) {
    // Patches share whatever budget remains after the summary.
    let patchBudget = Math.max(0, maxTokens - overhead - estimateTokens(summary))
    filesChanged = diffFiles.map((file) => {
      if (!file.patch) return { path: file.path, additions: file.additions, deletions: file.deletions }
      const { text: patch, truncated } = truncateToTokens(file.patch, patchBudget)
      patchBudget = Math.max(0, patchBudget - estimateTokens(patch))
      if (truncated) patchTruncated = true
      return { path: file.path, additions: file.additions, deletions: file.deletions, patch }
    })
  } else {
    filesChanged = diffFiles.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    }))
  }

  const rendered: CompactResult = {
    task_id: input.task_id,
    status: input.status,
    summary,
    truncated: summaryTruncated || patchTruncated,
    filesChanged,
    totalAdditions,
    totalDeletions,
    tokens: 0,
  }
  if (input.verification !== undefined) rendered.verification = input.verification
  if (input.todos !== undefined) rendered.todos = input.todos
  if (input.openQuestions !== undefined) rendered.openQuestions = input.openQuestions
  if (input.cost !== undefined) rendered.cost = input.cost
  if (input.tokensByModel !== undefined) rendered.tokensByModel = input.tokensByModel
  if (input.subagentCount !== undefined) rendered.subagentCount = input.subagentCount
  if (input.memory !== undefined) rendered.memory = input.memory
  if (input.worktree !== undefined) rendered.worktree = input.worktree

  rendered.tokens =
    overhead +
    estimateTokens(summary) +
    (includePatch
      ? filesChanged.reduce((sum, file) => sum + estimateTokens(file.patch ?? ""), 0)
      : 0)

  return rendered
}

export * as McpResult from "./result"

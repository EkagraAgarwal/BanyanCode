// Compact result builder for MCP delegation (Phase 1).
//
// Builds the bounded summary returned by `banyan_task_result`. The bound
// (default ~1.5K tokens, configurable) is what keeps the caller's usage low:
// the caller gets file +/- counts, verification outcome, open questions and
// todos, cost/tokens and memory refs — not the subagents' full transcripts.
//
// Token accounting uses a ~4 chars/token estimate. Patch content is only
// included when detail is "diff"; "summary" carries counts alone.
// "transcript" pages the session transcript in stable message-index order
// with a cursor; an empty page is terminal.

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

export interface WorktreeInput {
  path: string
  branch?: string
}

export interface TranscriptMessageInput {
  role: string
  text: string
}

export interface CompactResultInput {
  task_id: string
  status: string
  finalMessage?: string
  diffFiles?: DiffFileInput[]
  transcript?: TranscriptMessageInput[]
  verification?: VerificationInput
  todos?: TodoInput[]
  openQuestions?: OpenQuestionInput[]
  cost?: number
  tokensByModel?: Record<string, { input: number; output: number }>
  subagentCount?: number
  memory?: MemoryEntryInput[]
  worktree?: WorktreeInput
}

export interface TranscriptPage {
  messages: Array<{ index: number; role: string; text: string }>
  nextCursor?: string
}

export interface CompactResult {
  task_id: string
  status: string
  summary: string
  truncated: boolean
  filesChanged: Array<{ path: string; additions: number; deletions: number; patch?: string }>
  totalAdditions: number
  totalDeletions: number
  omittedFiles: number
  transcript?: TranscriptPage
  verification?: VerificationInput
  todos?: TodoInput[]
  openQuestions?: OpenQuestionInput[]
  cost?: number
  tokensByModel?: Record<string, { input: number; output: number }>
  subagentCount?: number
  memory?: MemoryEntryInput[]
  worktree?: WorktreeInput
  estimatedTokens: number
  /** Deprecated alias of estimatedTokens, kept for older readers. */
  tokens: number
}

export interface BuildResultOptions {
  maxTokens?: number
  detail?: ResultDetail
  cursor?: string
}

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

export function parseResultCursor(cursor?: string): number {
  if (!cursor) return 0
  const index = Number.parseInt(cursor, 10)
  if (!Number.isSafeInteger(index) || index < 0) return 0
  return index
}

const TRUNCATION_MARKER = "\n…[truncated]"

// File trimming always leaves this much room so a many-file diff cannot
// zero out the summary budget.
const MIN_SUMMARY_TOKENS = 50
// Summary share of a transcript page; the page itself gets the remainder.
const TRANSCRIPT_SUMMARY_MAX_TOKENS = 200

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

function churn(file: DiffFileInput): number {
  return file.additions + file.deletions
}

function sortByChurn(files: DiffFileInput[]): DiffFileInput[] {
  return [...files].sort((a, b) => churn(b) - churn(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function fileLineCost(file: DiffFileInput): number {
  return estimateTokens(`${file.path} +${file.additions}/-${file.deletions}\n`)
}

function transcriptMessageCost(role: string, text: string): number {
  return estimateTokens(role) + estimateTokens(text) + 2
}

export function buildCompactResult(input: CompactResultInput, opts: BuildResultOptions = {}): CompactResult {
  const maxTokens = opts.maxTokens ?? DEFAULT_RESULT_MAX_TOKENS
  const detail = opts.detail ?? "summary"
  const includePatch = detail === "diff"
  const showTranscript = detail === "transcript"

  const sorted = sortByChurn(input.diffFiles ?? [])
  const { totalAdditions, totalDeletions } = summarizeDiff(sorted)
  const transcript = input.transcript ?? []

  // Fixed overhead: structured fields outside the free-text summary.
  const fixedOverhead =
    estimateTokens(input.task_id) +
    estimateTokens(input.status) +
    estimateTokens(JSON.stringify(input.verification ?? null)) +
    estimateTokens(JSON.stringify(input.todos ?? [])) +
    estimateTokens(JSON.stringify(input.openQuestions ?? [])) +
    estimateTokens(JSON.stringify(input.tokensByModel ?? {})) +
    estimateTokens(JSON.stringify(input.memory ?? [])) +
    estimateTokens(JSON.stringify(input.worktree ?? null))

  // Trim the file list first: top N by churn, keeping room for the summary.
  const fitsWith = (files: DiffFileInput[]): boolean =>
    fixedOverhead + files.reduce((sum, file) => sum + fileLineCost(file), 0) + MIN_SUMMARY_TOKENS <= maxTokens
  let included = sorted
  if (!fitsWith(included)) {
    included = []
    for (const file of sorted) {
      const next = [...included, file]
      if (!fitsWith(next)) break
      included = next
    }
  }
  const omittedFiles = sorted.length - included.length
  const fileLinesCost = included.reduce((sum, file) => sum + fileLineCost(file), 0)

  // Transcript pages fill from the budget left after files; the summary
  // then takes a capped share of what remains.
  let transcriptPage: TranscriptPage | undefined
  let transcriptTruncated = false
  let pageTokens = 0
  if (showTranscript) {
    const start = parseResultCursor(opts.cursor)
    let pageBudget = Math.max(0, maxTokens - fixedOverhead - fileLinesCost)
    const messages: TranscriptPage["messages"] = []
    for (let index = start; index < transcript.length; index++) {
      const msg = transcript[index]
      if (!msg) continue
      const cost = transcriptMessageCost(msg.role, msg.text)
      if (messages.length > 0 && cost > pageBudget) break
      if (cost <= pageBudget) {
        messages.push({ index, role: msg.role, text: msg.text })
        pageBudget -= cost
        continue
      }
      const { text, truncated } = truncateToTokens(msg.text, Math.max(0, pageBudget - estimateTokens(msg.role) - 2))
      messages.push({ index, role: msg.role, text })
      if (truncated) transcriptTruncated = true
      pageBudget = 0
      break
    }
    pageTokens = messages.reduce((sum, msg) => sum + transcriptMessageCost(msg.role, msg.text), 0)
    transcriptPage = { messages }
    const end = start + messages.length
    if (end < transcript.length) transcriptPage.nextCursor = String(end)
  }

  const remaining = Math.max(0, maxTokens - fixedOverhead - fileLinesCost - pageTokens)
  const summaryBudget = showTranscript ? Math.min(TRANSCRIPT_SUMMARY_MAX_TOKENS, remaining) : remaining
  const { text: summary, truncated: summaryTruncated } = truncateToTokens(input.finalMessage ?? "", summaryBudget)
  const summaryTokens = estimateTokens(summary)

  let filesChanged: CompactResult["filesChanged"] = []
  let patchTruncated = false
  if (includePatch) {
    // Patches share whatever budget remains after the summary.
    let patchBudget = Math.max(0, maxTokens - fixedOverhead - fileLinesCost - summaryTokens)
    filesChanged = included.map((file) => {
      if (!file.patch) return { path: file.path, additions: file.additions, deletions: file.deletions }
      if (patchBudget <= 0) {
        patchTruncated = true
        return { path: file.path, additions: file.additions, deletions: file.deletions }
      }
      const { text: patch, truncated } = truncateToTokens(file.patch, patchBudget)
      patchBudget = Math.max(0, patchBudget - estimateTokens(patch))
      if (truncated) patchTruncated = true
      return { path: file.path, additions: file.additions, deletions: file.deletions, patch }
    })
  } else {
    filesChanged = included.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    }))
  }

  const rendered: CompactResult = {
    task_id: input.task_id,
    status: input.status,
    summary,
    truncated: false,
    filesChanged,
    totalAdditions,
    totalDeletions,
    omittedFiles,
    estimatedTokens: 0,
    tokens: 0,
  }
  if (transcriptPage !== undefined) rendered.transcript = transcriptPage
  if (input.verification !== undefined) rendered.verification = input.verification
  if (input.todos !== undefined) rendered.todos = input.todos
  if (input.openQuestions !== undefined) rendered.openQuestions = input.openQuestions
  if (input.cost !== undefined) rendered.cost = input.cost
  if (input.tokensByModel !== undefined) rendered.tokensByModel = input.tokensByModel
  if (input.subagentCount !== undefined) rendered.subagentCount = input.subagentCount
  if (input.memory !== undefined) rendered.memory = input.memory
  if (input.worktree !== undefined) rendered.worktree = input.worktree

  // Enforce the overall cap against the serialized JSON, trimming in
  // priority order: patches, summary, files, then the transcript page.
  // One token of headroom absorbs the count field's own digit growth.
  let truncated = summaryTruncated || patchTruncated || transcriptTruncated || omittedFiles > 0
  const target = Math.max(0, maxTokens - 1)
  let guard = 0
  for (;;) {
    const approx = estimateTokens(JSON.stringify({ ...rendered, estimatedTokens: 0, tokens: 0 }))
    rendered.estimatedTokens = approx
    rendered.tokens = approx
    if (estimateTokens(JSON.stringify(rendered)) <= target) break
    const page = rendered.transcript
    const patchFile = [...rendered.filesChanged].reverse().find((file) => file.patch !== undefined)
    if (patchFile !== undefined) {
      delete patchFile.patch
      truncated = true
    } else if (rendered.summary !== "") {
      const over = estimateTokens(JSON.stringify(rendered)) - target
      rendered.summary = truncateToTokens(rendered.summary, Math.max(0, estimateTokens(rendered.summary) - over)).text
      truncated = true
    } else if (rendered.filesChanged.length > 0) {
      rendered.filesChanged.pop()
      rendered.omittedFiles += 1
      truncated = true
    } else if (page !== undefined && page.messages.length > 1) {
      page.messages.pop()
      const start = parseResultCursor(opts.cursor)
      const end = start + page.messages.length
      if (end < transcript.length) page.nextCursor = String(end)
      else delete page.nextCursor
      truncated = true
    } else if (page !== undefined && page.messages.length === 1) {
      const only = page.messages[0]
      if (only === undefined || only.text === "") break
      const over = estimateTokens(JSON.stringify(rendered)) - target
      only.text = truncateToTokens(only.text, Math.max(0, estimateTokens(only.text) - over)).text
      truncated = true
    } else break
    guard += 1
    if (guard > 4000) break
  }
  rendered.truncated = truncated

  // Fixed point so estimatedTokens describes the JSON carrying it.
  for (let i = 0; i < 3; i++) {
    const remeasured = estimateTokens(JSON.stringify(rendered))
    if (remeasured === rendered.estimatedTokens) break
    rendered.estimatedTokens = remeasured
    rendered.tokens = remeasured
  }

  return rendered
}

export * as McpResult from "./result"

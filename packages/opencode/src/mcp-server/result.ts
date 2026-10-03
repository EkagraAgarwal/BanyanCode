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

// Verification aggregation (Milestone C5, gap-plan §5 C5).
//
// A task's `verification` field is sourced from verifier tool parts in the
// session transcript. The agent-side verifier tools are `banyan_test`,
// `banyan_typecheck` and `banyan_lint` (packages/core/src/tool/{test,
// typecheck,lint}.ts); `banyan_verify` is the MCP verify tool name and is
// accepted for forward-compat with C3. Only settled runs count: parts still
// `pending`/`running` are ignored. With no verifier parts the field stays
// absent — aggregateVerification returns undefined and the caller omits it,
// never fabricating a pass.
//
// The input is structural (not SessionV1.ToolPart) so this module stays
// dependency-free: the caller maps each tool part to { tool, status,
// output, error } where output is the completed state's output string and
// error is the error state's message.

export const VERIFIER_TOOL_NAMES = ["banyan_test", "banyan_typecheck", "banyan_lint", "banyan_verify"] as const
export type VerifierToolName = (typeof VERIFIER_TOOL_NAMES)[number]

export const isVerifierTool = (tool: string): boolean =>
  (VERIFIER_TOOL_NAMES as ReadonlyArray<string>).includes(tool)

// `banyan_test` -> `test`; unknown verifier names keep their full name.
export const verifierKindForTool = (tool: string): string =>
  tool.startsWith("banyan_") ? tool.slice("banyan_".length) : tool

export interface VerifierToolPartInput {
  tool: string
  status: string
  output?: string
  error?: string
}

export const DEFAULT_VERIFICATION_MAX_FAILURES = 10

// One failure line is capped so a single huge line cannot blow the result
// budget (the aggregated field is bounded: kinds + counts + N short lines,
// already covered by the verification share of fixedOverhead).
const VERIFICATION_FAILURE_LINE_MAX_CHARS = 500

const toNonNegativeCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0

const firstNonEmptyLines = (text: string | undefined, max: number): string[] => {
  if (!text || max <= 0) return []
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, max)
    .map((line) =>
      line.length > VERIFICATION_FAILURE_LINE_MAX_CHARS
        ? line.slice(0, VERIFICATION_FAILURE_LINE_MAX_CHARS) + "…[truncated]"
        : line,
    )
}

interface VerifierRun {
  kind: string
  passed: boolean
  passedCount: number
  failedCount: number
  skippedCount: number
  failures: string[]
}

// The completed state's output is the tool's output object serialized as a
// string: { status, summary: { passed, failed, skipped }, rawOutput? }.
// Older/diagnostic rows may instead carry the toModelOutput text rendering
// (`status=failed passed=8 failed=2 ...`), so parse that as a fallback.
function parseVerifierRun(tool: string, status: string, output: string | undefined, error: string | undefined): VerifierRun {
  const kind = verifierKindForTool(tool)
  if (status === "error") {
    return { kind, passed: false, passedCount: 0, failedCount: 0, skippedCount: 0, failures: firstNonEmptyLines(error, DEFAULT_VERIFICATION_MAX_FAILURES) }
  }
  if (!output) return { kind, passed: true, passedCount: 0, failedCount: 0, skippedCount: 0, failures: [] }
  try {
    const parsed = JSON.parse(output) as {
      status?: unknown
      summary?: unknown
      rawOutput?: unknown
    }
    const runStatus = typeof parsed.status === "string" ? parsed.status : "passed"
    const summary = (parsed.summary ?? {}) as Record<string, unknown>
    const run: VerifierRun = {
      kind,
      passed: runStatus === "passed",
      passedCount: toNonNegativeCount(summary["passed"]),
      failedCount: toNonNegativeCount(summary["failed"]),
      skippedCount: toNonNegativeCount(summary["skipped"]),
      failures: [],
    }
    if (!run.passed && typeof parsed.rawOutput === "string") {
      run.failures = firstNonEmptyLines(parsed.rawOutput, DEFAULT_VERIFICATION_MAX_FAILURES)
    }
    return run
  } catch {
    const runStatus = /status\s*=\s*(\w+)/.exec(output)?.[1] ?? "passed"
    const count = (name: string): number => {
      const match = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(output)
      return match?.[1] !== undefined ? Number.parseInt(match[1], 10) : 0
    }
    const passed = runStatus === "passed"
    return {
      kind,
      passed,
      passedCount: count("passed"),
      failedCount: count("failed"),
      skippedCount: count("skipped"),
      failures: passed ? [] : firstNonEmptyLines(output, DEFAULT_VERIFICATION_MAX_FAILURES),
    }
  }
}

export function aggregateVerification(
  parts: VerifierToolPartInput[],
  maxFailures: number = DEFAULT_VERIFICATION_MAX_FAILURES,
): VerificationInput | undefined {
  const runs: VerifierRun[] = []
  for (const part of parts) {
    if (!isVerifierTool(part.tool)) continue
    if (part.status !== "completed" && part.status !== "error") continue
    const run = parseVerifierRun(part.tool, part.status, part.output, part.error)
    if (maxFailures >= 0 && run.failures.length > maxFailures) run.failures = run.failures.slice(0, maxFailures)
    runs.push(run)
  }
  if (runs.length === 0) return undefined
  const kinds: string[] = []
  for (const run of runs) {
    if (!kinds.includes(run.kind)) kinds.push(run.kind)
  }
  const totals = new Map<string, { passed: number; failed: number; skipped: number }>()
  for (const run of runs) {
    const current = totals.get(run.kind) ?? { passed: 0, failed: 0, skipped: 0 }
    current.passed += run.passedCount
    current.failed += run.failedCount
    current.skipped += run.skippedCount
    totals.set(run.kind, current)
  }
  const counts = kinds
    .map((kind) => {
      const total = totals.get(kind) ?? { passed: 0, failed: 0, skipped: 0 }
      const base = `${kind}: ${total.passed} passed, ${total.failed} failed`
      return total.skipped > 0 ? `${base}, ${total.skipped} skipped` : base
    })
    .join("; ")
  const failures: string[] = []
  for (const run of runs) {
    for (const failure of run.failures) {
      if (failures.length >= maxFailures) break
      failures.push(failure)
    }
    if (failures.length >= maxFailures) break
  }
  const result: VerificationInput = {
    kind: kinds.length === 1 ? (kinds[0] ?? "verify") : kinds.join("+"),
    passed: runs.every((run) => run.passed),
  }
  if (counts.length > 0) result.counts = counts
  if (failures.length > 0) result.failures = failures
  return result
}

export * as McpResult from "./result"

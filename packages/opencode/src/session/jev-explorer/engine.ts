import { Cause, Effect, Option, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Info as BanyanConfigInfo } from "@opencode-ai/core/v1/config/banyan-config"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Jev } from "@opencode-ai/core/banyancode/jev"
import { PartID, type MessageID, type SessionID } from "../schema"
import { Session } from "../session"
import { JevActivity } from "../jev-activity"

// Jev-first exploration coordinator: for eligible read-only turns
// (explore/scout/researcher + `banyancode_jev_tree.enabled` + Jev key +
// fresh user turn + non json_schema format) the host runs a bounded,
// deterministic-first action tree and may complete the turn with a
// code-verified STOP before any model request. Anything else returns
// `{ type: "ineligible" }`/`{ type: "handoff" }` and the caller falls
// through to the existing LLM path unchanged.
//
// Rules encoded here:
// - Node 0 is deterministic (NO Jev): staleness gate, then repository_query
//   on the task text. A missing/stale graph hands off — a build is NEVER
//   triggered silently; the LLM path owns graph readiness.
// - Jev only chooses among indexed action IDs (<=20 options). Targets are
//   derived deterministically from task text + extracted candidates; raw
//   tool output never reaches Jev (state carries IDs/excerpts only).
// - Each paid Jev request is wrapped in JevActivity.start BEFORE the
//   request; a failed start skips the request entirely (fail-safe).
// - Confidence <0.8 or top-2 margin <0.2 or an invalid choice hands off.
// - Stop verification is code, not Jev: cited paths exist on disk, line
//   ranges are valid, graph versions match, web citations string-match the
//   fetched text. Unverified stop -> handoff with bounded evidence.
// - Budgets (nodes/depth/Jev calls/bytes/elapsed) are enforced centrally;
//   on exceed -> handoff, never a silent drop.
// - Cancellation (abort signal or fiber interrupt) settles the part
//   `cancelled` and falls through; interruption then propagates.

export const EXPLORER_AGENTS = ["explore", "scout", "researcher"] as const

export const isExplorerAgent = (name: string): boolean => (EXPLORER_AGENTS as readonly string[]).includes(name)

export const ACTIONS = [
  "REQUERY",
  "CODE_FIND",
  "GRAPH_TRAVERSE",
  "INSPECT_RESULT",
  "WEB_SEARCH",
  "WEB_FETCH",
  "STOP_WITH_EVIDENCE",
  "HANDOFF_TO_LLM",
] as const
export type ActionID = (typeof ACTIONS)[number]

const MIN_CONFIDENCE = 0.8
const MIN_MARGIN = 0.2
const STALENESS_HANDOFF_RATIO = 0.1
const MAX_STATE = 8_000
const MAX_CANDIDATES = 40
const CANDIDATES_IN_STATE = 20
const MAX_EVIDENCE_PER_NODE = 6
const MAX_ANSWER_EVIDENCE = 12
const DECIDE_ID = "tree"
// Consecutive dispatched-or-skipped iterations that advance neither depth nor
// evidence before the run hands off instead of looping to a budget.
const MAX_IDLE_STREAK = 4
// Exact raw-text span kept per web citation for verification. Display
// `excerpt` stays normalized + ellipsized and is never compared.
const WEB_VERIFY_LEN = 200

const QUESTION =
  "Read-only exploration step. Choose the next bounded action by its exact ID. " +
  "Choose STOP_WITH_EVIDENCE only when the collected evidence already answers the task with verifiable paths/symbols/line refs; " +
  "choose HANDOFF_TO_LLM when uncertain, out of scope, or beyond the budget."

const CRITERIA: Readonly<Record<ActionID, string>> = {
  REQUERY: "Re-run the semantic repository query on the task when results were thin.",
  CODE_FIND: "Locate a concrete symbol or file from the candidate list on the code graph.",
  GRAPH_TRAVERSE: "Traverse edges (callers/dependents/impact) from a known candidate.",
  INSPECT_RESULT: "Inspect a previously found path or symbol more closely.",
  WEB_SEARCH: "Search the web only when the question cannot be answered from the repository.",
  WEB_FETCH: "Fetch a candidate URL found by a prior web search.",
  STOP_WITH_EVIDENCE: "Stop only with verified, directly supported citations for the task.",
  HANDOFF_TO_LLM: "Hand the turn back to the model when uncertain or unsupported.",
}

export interface ToolOutcome {
  readonly ok: boolean
  readonly value: string
  readonly json?: unknown
  readonly bytes: number
}

export type ToolName = "repository_query" | "code_find" | "codegraph_staleness" | "websearch_free" | "webfetch"

export interface Deps {
  /** Permission gate run before EVERY deterministic dispatch; false => node failed, never dispatched. */
  readonly ask: (permission: string, pattern: string) => Effect.Effect<boolean>
  /** Deterministic dispatch (never via task tool, never via the LLM). */
  readonly call: (input: {
    readonly id: string
    readonly tool: ToolName
    readonly input: Record<string, unknown>
    readonly maxBytes: number
  }) => Effect.Effect<ToolOutcome>
  /** Stop-verification seam: does this workspace path (and optional line range) exist? */
  readonly verifyFile: (path: string, lines?: string) => Effect.Effect<boolean>
  /** Jev request seam; defaults to Jev.decide. Tests inject a wrapper/mock fetch — never the real network. */
  readonly decide?: (input: Jev.DecideInput) => Effect.Effect<Jev.DecideResult>
  readonly jev?: Pick<Jev.DecideInput, "fetch" | "env" | "apiKey" | "endpoint">
  readonly now?: () => number
}

export interface AttemptInput {
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly runID: string
  readonly agentName: string
  readonly task: string
  /** The turn's output format; json_schema turns are ineligible and must be threaded from the caller. */
  readonly format?: SessionV1.OutputFormat
  /** Test/injection overrides; production reads BanyanConfigService + process.env ambiently. */
  readonly config?: BanyanConfigInfo
  readonly env?: Jev.Env
  readonly abort?: AbortSignal
  readonly deps: Deps
}

/** Advisory evidence pointers for the V1 caller (bounded, source-linked only — never a proof). */
export interface HandoffEvidence {
  readonly path: string
  readonly lines?: string
  readonly excerpt?: string
  readonly graphVersion?: number
}
const MAX_HANDOFF_EVIDENCE = 8

export type Outcome =
  | { readonly type: "ineligible" }
  | { readonly type: "handoff"; readonly evidence?: readonly HandoffEvidence[] }
  | { readonly type: "cancelled" }
  | { readonly type: "completed"; readonly answer: string }

export interface EligibilityInput {
  readonly agentName: string
  readonly format?: SessionV1.OutputFormat
  readonly fresh: boolean
  readonly config?: BanyanConfigInfo
  readonly env?: Jev.Env
}

export interface Budgets {
  readonly maxDepth: number
  readonly maxNodes: number
  readonly maxJevCalls: number
  readonly timeoutMs: number
  readonly runTimeoutMs: number
  readonly maxBytes: number
}

/** Eligibility: explorer agent + explicit tree enable + Jev key + fresh turn + not json_schema. */
export const isEligible = (input: EligibilityInput): boolean =>
  input.fresh &&
  (EXPLORER_AGENTS as readonly string[]).includes(input.agentName) &&
  input.format?.type !== "json_schema" &&
  input.config?.banyancode_jev_tree?.enabled === true &&
  Jev.isEnabled(input.config ?? {}, input.env ?? process.env)

/** Effect wrapper reading BanyanConfigService ambiently (absent service => disabled). */
export const eligible: (input: {
  readonly agentName: string
  readonly format?: SessionV1.OutputFormat
  readonly fresh: boolean
}) => Effect.Effect<boolean> = Effect.fn("JevExplorer.eligible")(function* (input) {
  const option = yield* Effect.serviceOption(Banyan.BanyanConfigService)
  const config = Option.isSome(option) ? yield* option.value.get() : undefined
  return isEligible({ ...input, config })
})

const clamp = (value: number | undefined, fallback: number, min: number, max: number): number => {
  const parsed = value === undefined ? fallback : Math.trunc(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed || fallback, min), max)
}

export const resolveBudgets = (tree: BanyanConfigInfo["banyancode_jev_tree"]): Budgets => ({
  maxDepth: clamp(tree?.maxDepth, 4, 1, 12),
  maxNodes: clamp(tree?.maxNodes, 12, 1, 64),
  maxJevCalls: clamp(tree?.maxJevCalls, 8, 1, 64),
  timeoutMs: clamp(tree?.timeoutMs, 1_500, 1, 10_000),
  runTimeoutMs: clamp(tree?.runTimeoutMs, 30_000, 1, Number.MAX_SAFE_INTEGER),
  maxBytes: clamp(tree?.maxBytes, 262_144, 1_024, Number.MAX_SAFE_INTEGER),
})

const bound = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const PATH_RE =
  /(?:^|[\s"'`([{])((?:[A-Za-z]:)?(?:[\w.@+~-]+[\\/])+[\w.@+~-]+\.[A-Za-z0-9]{1,8})(?::(\d+)(?:\s*[-–]\s*(\d+))?)/g
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g
const SYMBOL_RE = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+\b/g

interface Evidence extends SessionV1.JevRunNodeEvidence {
  readonly graphVersion?: number
  /** Exact raw-text span kept for verification; stripped before publish. Display `excerpt` stays normalized. */
  readonly verify?: string
}

interface ExplorerNode extends Omit<SessionV1.JevRunNode, "evidence"> {
  readonly depth: number
  readonly evidence?: readonly Evidence[]
}

interface Candidate {
  readonly kind: "path" | "symbol" | "url"
  readonly value: string
  readonly usedBy: Set<ActionID>
}

const looksLikeFile = (value: string): boolean => /(?:^|[\\/])[^\\/\s]+\.\w{1,8}$/.test(value) || value.includes("/")

const graphVersionOf = (json: unknown): number | undefined => {
  if (typeof json !== "object" || json === null) return undefined
  const meta = (json as Record<string, unknown>).meta
  if (typeof meta !== "object" || meta === null) return undefined
  const version = (meta as Record<string, unknown>).graphVersion
  return typeof version === "number" && Number.isFinite(version) ? version : undefined
}

const excerptAt = (text: string, index: number): string => {
  const start = Math.max(0, index - 100)
  return bound(text.slice(start, start + 220).replace(/\s+/g, " ").trim(), 300)
}

const extractEvidence = (value: string, graphVersion: number | undefined): Evidence[] => {
  const found: Evidence[] = []
  const seen = new Set<string>()
  for (const match of value.matchAll(PATH_RE)) {
    const path = match[1].replace(/\\/g, "/")
    const lines = match[2] ? (match[3] ? `${match[2]}-${match[3]}` : match[2]) : undefined
    const key = `${path}::${lines ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push({ path, ...(lines ? { lines } : {}), excerpt: excerptAt(value, match.index ?? 0), ...(graphVersion === undefined ? {} : { graphVersion }) })
    if (found.length >= MAX_EVIDENCE_PER_NODE) break
  }
  return found
}

const normalizeDisplay = (text: string): string => bound(text.replace(/\s+/g, " ").trim(), 300)

const extractWebEvidence = (url: string, text: string, graphVersion: number | undefined): Evidence[] => [
  {
    path: url,
    excerpt: normalizeDisplay(text),
    verify: text.slice(0, WEB_VERIFY_LEN),
    ...(graphVersion === undefined ? {} : { graphVersion }),
  },
]

const extractCandidates = (value: string): Candidate[] => {
  const found: Candidate[] = []
  const seen = new Set<string>()
  const push = (kind: Candidate["kind"], raw: string) => {
    const value = kind === "path" ? raw.replace(/\\/g, "/") : raw.replace(/[.,;:!?]+$/, "")
    if (!value || value.length > 300) return
    const key = `${kind}:${value}`
    if (seen.has(key)) return
    seen.add(key)
    found.push({ kind, value, usedBy: new Set() })
  }
  for (const match of value.matchAll(PATH_RE)) push("path", match[1])
  for (const match of value.matchAll(URL_RE)) push("url", match[0])
  for (const match of value.matchAll(SYMBOL_RE)) push("symbol", match[0])
  return found.slice(0, MAX_CANDIDATES)
}

interface CallPlan {
  readonly tool: ToolName
  readonly permission: string
  readonly input: Record<string, unknown>
}

const planFor = (action: ActionID, target: string): CallPlan | undefined => {
  switch (action) {
    case "REQUERY":
      return { tool: "repository_query", permission: "repository_query", input: { query: bound(target, 400), limit: 10 } }
    case "INSPECT_RESULT":
      return { tool: "repository_query", permission: "repository_query", input: { query: bound(target, 400), limit: 10 } }
    case "CODE_FIND":
      return {
        tool: "code_find",
        permission: "code_find",
        input: {
          intent: looksLikeFile(target) ? "find_file" : "definition",
          target: bound(target, 300),
          includeKeywordFallback: true,
          limit: 25,
        },
      }
    case "GRAPH_TRAVERSE":
      return {
        tool: "code_find",
        permission: "code_find",
        input: {
          intent: looksLikeFile(target) ? "impact" : "callers",
          target: bound(target, 300),
          includeKeywordFallback: true,
          limit: 25,
        },
      }
    case "WEB_SEARCH":
      return { tool: "websearch_free", permission: "websearch_free", input: { query: bound(target, 300), numResults: 8 } }
    case "WEB_FETCH":
      return { tool: "webfetch", permission: "webfetch", input: { url: target } }
    default:
      return undefined
  }
}

const parseStaleness = (outcome: ToolOutcome): { staleFiles: number; missingFiles: number; totalFiles: number } | undefined => {
  if (outcome.json && typeof outcome.json === "object" && outcome.json !== null) {
    const record = outcome.json as Record<string, unknown>
    const pick = (key: string) => (typeof record[key] === "number" ? (record[key] as number) : undefined)
    const staleFiles = pick("staleFiles")
    const missingFiles = pick("missingFiles")
    const totalFiles = pick("totalFiles")
    if (staleFiles !== undefined && missingFiles !== undefined && totalFiles !== undefined)
      return { staleFiles, missingFiles, totalFiles }
  }
  const match = /staleFiles=(\d+)\s+missingFiles=(\d+)\s+totalFiles=(\d+)/.exec(outcome.value)
  if (!match) return undefined
  return { staleFiles: Number(match[1]), missingFiles: Number(match[2]), totalFiles: Number(match[3]) }
}

const toContractNode = (node: ExplorerNode): SessionV1.JevRunNode => {
  const { depth: _depth, evidence, ...rest } = node
  return {
    ...rest,
    ...(evidence
      ? {
          evidence: evidence.map(({ graphVersion: _version, verify: _verify, ...entry }) => entry),
        }
      : {}),
  }
}

const toHandoffEvidence = (entries: readonly Evidence[]): readonly HandoffEvidence[] =>
  entries
    .slice(0, MAX_HANDOFF_EVIDENCE)
    .map((entry) => ({
      path: entry.path,
      ...(entry.lines ? { lines: entry.lines } : {}),
      ...(entry.excerpt ? { excerpt: entry.excerpt } : {}),
      ...(entry.graphVersion === undefined ? {} : { graphVersion: entry.graphVersion }),
    }))

const renderAnswer = (evidence: readonly Evidence[]): string =>
  [
    "Jev explorer verified evidence:",
    ...evidence.slice(0, MAX_ANSWER_EVIDENCE).map(
      (entry) => `- ${entry.path}${entry.lines ? `:${entry.lines}` : ""}${entry.excerpt ? ` — ${entry.excerpt}` : ""}`,
    ),
  ].join("\n")

const shortCause = (cause: unknown): string => bound(String(cause instanceof Error ? cause.message : cause), 160)

/** Deterministic target derivation: Jev picks the action; the target comes from task/candidates. */
const resolveTarget = (action: ActionID, task: string, candidates: readonly Candidate[]): string | undefined => {
  if (action === "REQUERY" || action === "WEB_SEARCH") return task.slice(0, 400)
  const kinds: ReadonlyArray<Candidate["kind"]> =
    action === "WEB_FETCH"
      ? ["url"]
      : action === "INSPECT_RESULT"
        ? ["path", "symbol"]
        : ["symbol", "path"]
  const next = candidates.find((entry) => kinds.includes(entry.kind) && !entry.usedBy.has(action))
  if (!next) return undefined
  next.usedBy.add(action)
  return next.value
}

export const attempt: (input: AttemptInput) => Effect.Effect<Outcome, never, Session.Service> = Effect.fn(
  "JevExplorer.attempt",
)(function* (input: AttemptInput) {
  const sessions = yield* Session.Service
  const configOption = yield* Effect.serviceOption(Banyan.BanyanConfigService)
  const ambientConfig = Option.isSome(configOption) ? yield* configOption.value.get() : undefined
  const config = input.config ?? ambientConfig
  if (!isEligible({ agentName: input.agentName, format: input.format, fresh: true, config, env: input.env }))
    return { type: "ineligible" }

  const budgets = resolveBudgets(config?.banyancode_jev_tree)
  const now = input.deps.now ?? Date.now
  const startedAt = now()
  const partID = PartID.ascending()
  const nodes: ExplorerNode[] = []
  const candidates: Candidate[] = []
  const webTexts = new Map<string, string>()
  const dedup = new Set<string>()
  let usageInput = 0
  let usageOutput = 0
  let usageCost: number | undefined
  let bytes = 0
  let jevCalls = 0
  let graphVersion: number | undefined
  let settled = false

  const publish = (status: SessionV1.JevRunStatus, stopReason?: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const part = {
        id: partID,
        sessionID: input.sessionID,
        messageID: input.messageID,
        type: "jev_run" as const,
        runID: bound(input.runID, 128),
        status,
        nodes: nodes.slice(0, 64).map(toContractNode),
        ...(stopReason ? { stopReason: bound(stopReason, 300) } : {}),
        ...(usageInput > 0 || usageOutput > 0 || usageCost !== undefined
          ? { usage: { input: usageInput, output: usageOutput, ...(usageCost === undefined ? {} : { cost: usageCost }) } }
          : {}),
      } satisfies SessionV1.JevRunPart
      const valid = yield* Schema.decodeUnknownEffect(SessionV1.JevRunPart)(part).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!valid) {
        yield* Effect.logWarning("jev-explorer: part failed schema validation; skipped publish", {
          "session.id": input.sessionID,
        })
        return
      }
      yield* sessions.updatePart(part).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("jev-explorer: part publish failed", {
            "session.id": input.sessionID,
            error: shortCause(cause),
          }),
        ),
      )
    })

  const handoffWithEvidence = (): { readonly type: "handoff"; readonly evidence?: readonly HandoffEvidence[] } => {
    const collected = toHandoffEvidence(nodes.flatMap((node) => node.evidence ?? []))
    return collected.length > 0 ? { type: "handoff", evidence: collected } : { type: "handoff" }
  }

  const finish = <A>(status: SessionV1.JevRunStatus, reason: string | undefined, outcome: A): Effect.Effect<A> =>
    Effect.gen(function* () {
      settled = true
      yield* publish(status, reason)
      if (status === "handoff" && typeof outcome === "object" && outcome !== null) {
        const record = outcome as Record<string, unknown>
        if (record["type"] === "handoff" && record["evidence"] === undefined) {
          const collected = toHandoffEvidence(nodes.flatMap((node) => node.evidence ?? []))
          if (collected.length > 0) return { ...record, evidence: collected } as A
        }
      }
      return outcome
    })

  const cancelled = () =>
    Effect.gen(function* () {
      if (settled) return { type: "cancelled" } as const
      return yield* finish("cancelled", "cancelled", { type: "cancelled" } as const)
    })

  yield* publish("running")

  const body = Effect.gen(function* () {
    if (input.abort?.aborted) return yield* cancelled()

    // Node 0 — deterministic, no Jev: staleness gate, then repository_query.
    const gatePermitted = yield* input.deps.ask("codegraph_staleness", "*")
    if (!gatePermitted) return yield* finish("handoff", "permission-denied:codegraph_staleness", { type: "handoff" } as const)
    const staleness = yield* input.deps.call({
      id: "jev-n0-stale",
      tool: "codegraph_staleness",
      input: {},
      maxBytes: budgets.maxBytes,
    })
    bytes += staleness.bytes
    if (!staleness.ok) return yield* finish("handoff", "graph-unavailable", { type: "handoff" } as const)
    const drift = parseStaleness(staleness)
    if (!drift || drift.totalFiles === 0)
      return yield* finish("handoff", "graph-missing: no code graph is indexed", { type: "handoff" } as const)
    if ((drift.staleFiles + drift.missingFiles) / drift.totalFiles >= STALENESS_HANDOFF_RATIO)
      return yield* finish(
        "handoff",
        `graph-stale: ${drift.staleFiles} stale + ${drift.missingFiles} missing of ${drift.totalFiles} files`,
        { type: "handoff" } as const,
      )
    if (bytes > budgets.maxBytes) return yield* finish("handoff", "budget:max-bytes", { type: "handoff" } as const)

    const permitted0 = yield* input.deps.ask("repository_query", bound(input.task, 400))
    if (!permitted0) return yield* finish("handoff", "permission-denied:repository_query", { type: "handoff" } as const)

    const first = yield* input.deps.call({
      id: "jev-n0",
      tool: "repository_query",
      input: { query: bound(input.task, 400), limit: 10 },
      maxBytes: budgets.maxBytes,
    })
    bytes += first.bytes
    // Budget BEFORE extraction: an over-budget payload must never enter
    // evidence or the candidate pool (handoff, never a silent drop).
    if (bytes > budgets.maxBytes) {
      nodes.push({
        nodeID: "n0",
        actionID: "REPOSITORY_QUERY",
        target: bound(input.task, 400),
        status: "failed",
        depth: 0,
      })
      return yield* finish("handoff", "budget:max-bytes", { type: "handoff" } as const)
    }
    const version = graphVersionOf(first.json)
    if (version !== undefined) graphVersion = version
    nodes.push({
      nodeID: "n0",
      actionID: "REPOSITORY_QUERY",
      target: bound(input.task, 400),
      status: first.ok ? "done" : "failed",
      depth: 0,
      ...(first.ok ? { evidence: extractEvidence(first.value, graphVersion) } : {}),
    })
    if (first.ok) candidates.push(...extractCandidates(first.value))
    yield* publish("running")

    let parentId = "n0"
    let depth = 0
    let counter = 0
    // Iterations that advance neither depth nor evidence (skipped/deduped/
    // denied/failed dispatches). Independent of semantic depth; at the bound
    // the run hands off instead of looping to a budget.
    let idleStreak = 0
    const noteIdle = (): Effect.Effect<Outcome | undefined> =>
      Effect.gen(function* () {
        idleStreak++
        if (idleStreak >= MAX_IDLE_STREAK)
          return yield* finish("handoff", "idle-streak: no progress", handoffWithEvidence())
        yield* publish("running")
        return undefined
      })

    while (true) {
      if (input.abort?.aborted) return yield* cancelled()
      if (now() - startedAt > budgets.runTimeoutMs)
        return yield* finish("handoff", "budget:run-timeout", { type: "handoff" } as const)
      if (jevCalls >= budgets.maxJevCalls)
        return yield* finish("handoff", "budget:max-jev-calls", { type: "handoff" } as const)
      if (nodes.length >= budgets.maxNodes)
        return yield* finish("handoff", "budget:max-nodes", { type: "handoff" } as const)
      if (bytes > budgets.maxBytes) return yield* finish("handoff", "budget:max-bytes", { type: "handoff" } as const)

      const state = bound(
        [
          `task: ${bound(input.task, 1_500)}`,
          `graphVersion: ${graphVersion ?? "unknown"}`,
          `budget: nodes ${nodes.length}/${budgets.maxNodes} jev ${jevCalls}/${budgets.maxJevCalls} bytes ${bytes}/${budgets.maxBytes} depth ${depth}/${budgets.maxDepth}`,
          `nodes:`,
          ...nodes.slice(-16).map((node) =>
            bound(
              `${node.nodeID}|${node.parentID ?? "-"}|${node.actionID}|${node.target}|${node.status}|${(node.evidence ?? [])
                .slice(0, 3)
                .map((entry) => entry.path)
                .join(",")}`,
              180,
            ),
          ),
          `candidates: ${bound(
            candidates
              .slice(0, CANDIDATES_IN_STATE)
              .map((entry) => entry.value)
              .join(", "),
            1_200,
          )}`,
        ].join("\n"),
        MAX_STATE,
      )

      // Activity BEFORE every paid Jev request; a failed start skips it.
      const activity = yield* JevActivity.start({
        sessionID: input.sessionID,
        messageID: input.messageID,
        operationID: bound(`jev-tree:${input.runID}:${jevCalls}`, 128),
        feature: "jev-explorer",
      }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!activity) return yield* finish("handoff", "activity-unavailable: no request sent", { type: "handoff" } as const)
      jevCalls++

      const decideInput: Jev.DecideInput = {
        state,
        question: QUESTION,
        choices: ACTIONS,
        criteria: CRITERIA,
        id: DECIDE_ID,
        ...(config ? { config } : {}),
        timeoutMs: budgets.timeoutMs,
        ...input.deps.jev,
        ...(input.abort ? { signal: input.abort } : {}),
        sessionID: input.sessionID,
        scope: bound(input.runID, 128),
      }
      const result = yield* (input.deps.decide ?? ((i: Jev.DecideInput) => Effect.promise(() => Jev.decide(i))))(
        decideInput,
      ).pipe(
        Effect.catchCause(() =>
          Effect.logWarning("jev-explorer: decide seam failed", { "session.id": input.sessionID }).pipe(
            Effect.map(() => undefined),
          ),
        ),
      )
      if (!result) {
        yield* activity
          .finish({ status: "failed", summary: "explorer decide failed before an answer" })
          .pipe(Effect.catchCause(() => Effect.void))
        return yield* finish("handoff", "jev-decide-failed", { type: "handoff" } as const)
      }
      yield* activity
        .finish({
          status: result.ok ? "completed" : "failed",
          ...(result.ok ? { choice: bound(result.choice, 120) } : {}),
          summary: bound(result.ok ? `Jev selected ${result.choice}` : `${result.reason}: ${result.message}`, 400),
          latency: { ms: result.latencyMs },
          usage: result.ok
            ? {
                input: result.usage?.inputTokens ?? 0,
                output: result.usage?.outputTokens ?? 0,
                ...(result.usage?.cost === undefined ? {} : { cost: result.usage.cost }),
              }
            : undefined,
        })
        .pipe(Effect.catchCause(() => Effect.void))
      if (result.ok) {
        usageInput += result.usage?.inputTokens ?? 0
        usageOutput += result.usage?.outputTokens ?? 0
        if (result.usage?.cost !== undefined) usageCost = (usageCost ?? 0) + result.usage.cost
      }
      if (!result.ok) return yield* finish("handoff", `jev-error:${result.reason}`, { type: "handoff" } as const)

      const confidence = result.confidence
      if (confidence < MIN_CONFIDENCE)
        return yield* finish("handoff", `low-confidence:${confidence.toFixed(2)}`, { type: "handoff" } as const)
      const ordered = ACTIONS.map((action) => result.probabilities[action] ?? 0).sort((a, b) => b - a)
      const margin = (ordered[0] ?? 0) - (ordered[1] ?? 0)
      if (margin < MIN_MARGIN)
        return yield* finish("handoff", `narrow-margin:${margin.toFixed(2)}`, { type: "handoff" } as const)
      if (!(ACTIONS as readonly string[]).includes(result.choice))
        return yield* finish("handoff", "invalid-choice", { type: "handoff" } as const)
      const action = result.choice as ActionID

      if (action === "HANDOFF_TO_LLM") {
        nodes.push({
          nodeID: `n${++counter}`,
          parentID: parentId,
          actionID: action,
          target: "",
          status: "failed",
          depth,
        })
        return yield* finish("handoff", "jev-handoff", { type: "handoff" } as const)
      }

      if (action === "STOP_WITH_EVIDENCE") {
        const stopNodeID = `n${++counter}`
        const all = nodes.flatMap((node) => node.evidence ?? [])
        if (all.length === 0) {
          nodes.push({ nodeID: stopNodeID, parentID: parentId, actionID: action, target: "", status: "failed", depth })
          return yield* finish("handoff", "unverified-stop: no evidence", { type: "handoff" } as const)
        }
        const verified: Evidence[] = []
        const seen = new Set<string>()
        let failure: string | undefined
        for (const entry of all) {
          const key = `${entry.path}::${entry.lines ?? ""}`
          if (seen.has(key)) continue
          seen.add(key)
          if (entry.graphVersion !== undefined && graphVersion !== undefined && entry.graphVersion !== graphVersion) {
            failure = `graph-version-mismatch:${bound(entry.path, 80)}`
            break
          }
          if (/^https?:\/\//.test(entry.path)) {
            // Exact raw-span check: display `excerpt` is normalized +
            // ellipsized and is never compared; `verify` is the raw slice.
            const stored = webTexts.get(entry.path)
            const span = entry.verify
            if (!span || !stored || !stored.includes(span)) {
              failure = `web-citation-unverified:${bound(entry.path, 80)}`
              break
            }
            verified.push(entry)
            continue
          }
          const ok = yield* input.deps.verifyFile(entry.path, entry.lines).pipe(
            Effect.catchCause(() => Effect.succeed(false)),
          )
          if (!ok) {
            failure = `unverified-path:${bound(entry.path, 80)}`
            break
          }
          verified.push(entry)
        }
        if (failure) {
          nodes.push({
            nodeID: stopNodeID,
            parentID: parentId,
            actionID: action,
            target: "",
            status: "failed",
            depth,
            evidence: verified.slice(0, MAX_EVIDENCE_PER_NODE),
          })
          return yield* finish("handoff", failure, { type: "handoff" } as const)
        }
        if (verified.length === 0) {
          nodes.push({ nodeID: stopNodeID, parentID: parentId, actionID: action, target: "", status: "failed", depth })
          return yield* finish("handoff", "unverified-stop: no evidence", { type: "handoff" } as const)
        }
        nodes.push({
          nodeID: stopNodeID,
          parentID: parentId,
          actionID: action,
          target: "",
          status: "done",
          depth,
          confidence,
          latencyMs: result.latencyMs,
          evidence: verified.slice(0, MAX_EVIDENCE_PER_NODE),
        })
        const answer = renderAnswer(verified)
        return yield* finish("completed", undefined, { type: "completed", answer } as const)
      }

      const target = resolveTarget(action, input.task, candidates)
      const nodeID = `n${++counter}`
      if (!target) {
        nodes.push({ nodeID, parentID: parentId, actionID: action, target: "", status: "skipped", depth, confidence, latencyMs: result.latencyMs })
        const idle = yield* noteIdle()
        if (idle) return idle
        continue
      }
      const dedupKey = `${action}\u0000${target}\u0000${graphVersion ?? "none"}`
      if (dedup.has(dedupKey)) {
        nodes.push({ nodeID, parentID: parentId, actionID: action, target: bound(target, 400), status: "skipped", depth, confidence, latencyMs: result.latencyMs })
        const idle = yield* noteIdle()
        if (idle) return idle
        continue
      }
      dedup.add(dedupKey)

      const plan = planFor(action, target)
      if (!plan) {
        nodes.push({ nodeID, parentID: parentId, actionID: action, target: bound(target, 400), status: "failed", depth, confidence, latencyMs: result.latencyMs })
        const idle = yield* noteIdle()
        if (idle) return idle
        continue
      }
      // Budget BEFORE the permission prompt: a run already at max depth
      // hands off without ever prompting the user.
      const nextDepth = depth + 1
      if (nextDepth > budgets.maxDepth)
        return yield* finish("handoff", "budget:max-depth", { type: "handoff" } as const)
      const permitted = yield* input.deps.ask(plan.permission, bound(target, 400))
      if (!permitted) {
        nodes.push({ nodeID, parentID: parentId, actionID: action, target: bound(target, 400), status: "failed", depth, confidence, latencyMs: result.latencyMs })
        const idle = yield* noteIdle()
        if (idle) return idle
        continue
      }

      const outcome = yield* input.deps.call({
        id: `jev-${nodeID}`,
        tool: plan.tool,
        input: plan.input,
        maxBytes: budgets.maxBytes,
      })
      bytes += outcome.bytes
      // Budget BEFORE evidence extraction / candidate intake (node0 path
      // above does the same): over-budget payloads never feed the tree.
      if (bytes > budgets.maxBytes) {
        nodes.push({
          nodeID,
          parentID: parentId,
          actionID: action,
          target: bound(target, 400),
          status: "failed",
          depth,
          confidence,
          latencyMs: result.latencyMs,
        })
        return yield* finish("handoff", "budget:max-bytes", { type: "handoff" } as const)
      }
      const version = graphVersionOf(outcome.json)
      if (version !== undefined) graphVersion = version
      const evidence = outcome.ok
        ? plan.tool === "webfetch"
          ? extractWebEvidence(target, outcome.value, graphVersion)
          : extractEvidence(outcome.value, graphVersion)
        : []
      if (outcome.ok && plan.tool !== "webfetch") candidates.push(...extractCandidates(outcome.value))
      if (outcome.ok && plan.tool === "webfetch") webTexts.set(target, outcome.value)
      nodes.push({
        nodeID,
        parentID: parentId,
        actionID: action,
        target: bound(target, 400),
        status: outcome.ok ? "done" : "failed",
        depth: nextDepth,
        confidence,
        latencyMs: result.latencyMs,
        ...(evidence.length > 0 ? { evidence } : {}),
      })
      if (outcome.ok) {
        parentId = nodeID
        depth = nextDepth
        idleStreak = 0
        yield* publish("running")
        continue
      }
      const idle = yield* noteIdle()
      if (idle) return idle
    }
  })

  return yield* body.pipe(
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        if (settled) return yield* Effect.die(Cause.squash(cause))
        yield* Effect.logWarning("jev-explorer: run defect; settling failed part", {
          "session.id": input.sessionID,
          error: shortCause(Cause.squash(cause)),
        })
        return yield* finish("failed", `run-failed:${shortCause(Cause.squash(cause))}`, handoffWithEvidence())
      }),
    ),
    Effect.onInterrupt(() => (settled ? Effect.void : publish("cancelled", "interrupted"))),
  )
})

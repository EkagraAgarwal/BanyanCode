export * as Jev from "./jev"

import { createHash } from "node:crypto"
import type { Info as BanyanConfigInfo } from "../v1/config/banyan-config"
import { JevLedger } from "./jev-ledger"

// Jev (TypeSafe "System One") HTTP decision client. POST a `state` plus
// typed questions, get back probabilities over a bounded option set.
// `ask`/`decide` never throw: every failure is `{ ok: false, reason }`.
// On non-ok, escalate the question back to the LLM / user.
//
// Redaction runs before network access and cache hashing. Effect callers
// use `./jev-service.ts` (consumer-level adapter, never mounted globally).

export type Backend = "typesafe" | "openrouter" | "vercel"

export const BACKENDS = ["typesafe", "openrouter", "vercel"] as const

export const DEFAULT_BACKEND: Backend = "typesafe"

export const DEFAULT_MODELS: Record<Backend, string> = {
  typesafe: "jev-latest",
  openrouter: "typesafe/jev-latest",
  vercel: "typesafe-ai/jev",
}

export const ENDPOINTS: Record<Backend, string> = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  openrouter: "https://openrouter.ai/api/v1/systemone",
  vercel: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
}

export const KEY_ENV: Record<Backend, readonly string[]> = {
  typesafe: ["BANYANCODE_JEV_API_KEY", "TYPESAFE_API_KEY"],
  openrouter: ["BANYANCODE_JEV_API_KEY"],
  vercel: ["BANYANCODE_JEV_API_KEY"],
}

export const MIN_CHOICES = 2
export const MAX_CHOICES = 255
export const MIN_SCORE_CRITERIA = 2
export const MAX_SCORE_CRITERIA = 10
export const MAX_QUESTIONS = 25
export const DEFAULT_QUESTION_ID = "decision"
export const DEFAULT_TIMEOUT_MS = 5_000
export const MAX_STATE_CHARS = 120_000
export const MAX_INSTRUCTIONS_CHARS = 8_000
export const MAX_CRITERION_CHARS = 2_000
export const MAX_QUESTION_ID_CHARS = 128
export const MAX_STATE_PLUS_LONGEST_TOKENS = 32_000
export const MAX_TOTAL_TOKENS = 64_000
export const JEV_USD_PER_MTOKEN = 0.042

export const DEFAULT_SESSION_ID = "default"
export const DEFAULT_SCOPE = "default"

export const DEFAULT_MAX_INFLIGHT = 8
export const DEFAULT_REQUESTS_PER_MINUTE = 120
export const DEFAULT_TOKENS_PER_MINUTE = 120_000
export const DEFAULT_CACHE_MAX_ENTRIES = 128
export const DEFAULT_CACHE_TTL_MS = 300_000
export const DEFAULT_RETRIES = 2

export type Env = Record<string, string | undefined>

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type JevProfile = "conservative" | "aggressive"

export type JevFeatureName =
  | "judge"
  | "explorer"
  | "subagent-routing"
  | "turn-routing"
  | "context-rerank"
  | "compaction-routing"
  | "review-routing"

export const JEV_FEATURES: readonly JevFeatureName[] = [
  "judge",
  "explorer",
  "subagent-routing",
  "turn-routing",
  "context-rerank",
  "compaction-routing",
  "review-routing",
]

export interface JevModelTiers {
  readonly fast?: string
  readonly strong?: string
  readonly fastThinking?: string
  readonly strongThinking?: string
}

export interface JevBudget {
  readonly perTurnCalls?: number
  readonly perSessionUsd?: number
}

export interface JevClientOptions {
  readonly maxInflight?: number
  readonly requestsPerMinute?: number
  readonly tokensPerMinute?: number
  readonly cacheMaxEntries?: number
  readonly cacheTtlMs?: number
  readonly retries?: number
}

export type Config = Pick<
  BanyanConfigInfo,
  "banyancode_jev_enabled" | "banyancode_jev_backend" | "banyancode_jev_model"
> & {
  readonly banyancode_jev_profile?: JevProfile
  readonly banyancode_jev_features?: Readonly<Record<string, boolean>>
  readonly banyancode_jev_model_tiers?: JevModelTiers
  readonly banyancode_jev_budget?: JevBudget
  readonly banyancode_jev_client?: JevClientOptions
  readonly banyancode_jev_tree?: { readonly enabled?: boolean }
  readonly banyancode_jev_subagent_models?: Readonly<Record<string, { readonly model: string }>>
}

export type Failure =
  | "disabled"
  | "missing-key"
  | "invalid-input"
  | "http-error"
  | "timeout"
  | "network"
  | "invalid-answer"
  | "cancelled"
  | "budget-exceeded"
  | "rate-limited"

export type DecideFailure = Failure

export interface NoulQuestion {
  readonly type: "noul"
  readonly instructions: string
  readonly criteria?: { readonly true?: string; readonly false?: string }
}

export interface ChoiceQuestion {
  readonly type: "choice"
  readonly instructions: string
  readonly criteria: Readonly<Record<string, string | null>>
}

export interface ScoreQuestion {
  readonly type: "score"
  readonly instructions: string
  readonly criteria: readonly string[]
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion

export interface NoulAnswer {
  readonly type: "noul"
  readonly noul: number
}

export interface ChoiceAnswer {
  readonly type: "choice"
  readonly choice: string
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence: number
}

export interface ScoreAnswer {
  readonly type: "score"
  readonly score: number
  readonly legend: Readonly<Record<string, string>>
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence: number
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export type Usage = {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cost?: number
}

export type UsageSnapshot = JevLedger.UsageSnapshot

interface CommonOptions {
  readonly config?: Config
  readonly backend?: Backend
  readonly model?: string
  readonly apiKey?: string
  readonly endpoint?: string
  readonly timeoutMs?: number
  readonly env?: Env
  readonly fetch?: Fetch
  readonly signal?: AbortSignal
  readonly sessionID?: string
  readonly feature?: string
  readonly scope?: string
}

export interface DecideInput extends CommonOptions {
  readonly state: string
  readonly question: string
  readonly choices: readonly string[]
  readonly criteria?: Readonly<Record<string, string | null | undefined>>
  readonly id?: string
}

export interface AskInput extends CommonOptions {
  readonly state: string
  readonly questions: Readonly<Record<string, Question>>
}

export interface DecideSuccess {
  readonly ok: true
  readonly choice: string
  readonly confidence: number
  readonly probabilities: Readonly<Record<string, number>>
  readonly backend: Backend
  readonly model: string
  readonly latencyMs: number
  readonly usage?: Usage
  readonly cached?: boolean
}

export interface DecideError {
  readonly ok: false
  readonly reason: DecideFailure
  readonly message: string
  readonly backend: Backend
  readonly latencyMs: number
  readonly status?: number
}

export type DecideResult = DecideSuccess | DecideError

export interface AskSuccess {
  readonly ok: true
  readonly answers: Readonly<Record<string, Answer>>
  readonly backend: Backend
  readonly model: string
  readonly latencyMs: number
  readonly usage?: Usage
  readonly cached?: boolean
}

export interface AskError {
  readonly ok: false
  readonly reason: Failure
  readonly message: string
  readonly backend: Backend
  readonly latencyMs: number
  readonly status?: number
}

export type AskResult = AskSuccess | AskError

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const nameOf = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "name" in cause && typeof cause.name === "string"
    ? cause.name
    : undefined

const isAbort = (cause: unknown): boolean => nameOf(cause) === "TimeoutError" || nameOf(cause) === "AbortError"

export const keyFor = (backend: Backend, env: Env = process.env): string | undefined =>
  (BACKENDS.includes(backend) ? KEY_ENV[backend] : [])
    .map((name) => (typeof env[name] === "string" ? env[name]?.trim() : undefined))
    .find((value): value is string => Boolean(value))

export interface Resolution {
  readonly enabled: boolean
  readonly backend: Backend
  readonly model: string
  readonly apiKey: string | undefined
}

export const resolve = (config: Config = {}, env: Env = process.env): Resolution => {
  const backend = config.banyancode_jev_backend ?? DEFAULT_BACKEND
  const apiKey = keyFor(backend, env)
  return {
    enabled:
      config.banyancode_jev_enabled !== false &&
      Boolean(apiKey) &&
      (Boolean(env.BANYANCODE_JEV_API_KEY?.trim()) ||
        (backend === "typesafe" && Boolean(env.TYPESAFE_API_KEY?.trim()))),
    backend,
    model: config.banyancode_jev_model ?? DEFAULT_MODELS[backend],
    apiKey,
  }
}

export const isEnabled = (config: Config = {}, env: Env = process.env): boolean => resolve(config, env).enabled

export const feature = (config: Config = {}, env: Env = process.env, name: string): boolean => {
  if (config.banyancode_jev_enabled === false) return false
  const override = config.banyancode_jev_features?.[name]
  if (override === false) return false
  const backend = config.banyancode_jev_backend ?? DEFAULT_BACKEND
  if (!resolve({ ...config, banyancode_jev_backend: backend }, env).enabled) return false
  if (name === "explorer" && config.banyancode_jev_tree?.enabled === false) return false
  if (override === true) return true
  if (name === "judge") return true
  if (name === "explorer") return config.banyancode_jev_tree?.enabled === true
  if (
    name === "subagent-routing" &&
    config.banyancode_jev_enabled === true &&
    Object.keys(config.banyancode_jev_subagent_models ?? {}).length > 0
  )
    return true
  if (config.banyancode_jev_profile === "aggressive") return true
  return false
}

export const usage = (sessionID: string): UsageSnapshot => JevLedger.snapshot(sessionID || DEFAULT_SESSION_ID)

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g
const BEARER_TOKEN = /[Bb]earer\s+[A-Za-z0-9\-._~+/=]{8,}/g
const LONG_LIVED_TOKEN =
  /\b(sk-[A-Za-z0-9\-_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[bpas]-[A-Za-z0-9\-]{8,}|AKIA[0-9A-Z]{16})\b/g
const ASSIGNED_SECRET =
  /((?:api[_-]?key|secret|passwd|password|pwd|token|auth[_-]?token|access[_-]?token)\s*[:=]\s*)([^\s'";,]{4,})/gi
const QUOTED_SECRET =
  /((?:api[_-]?key|secret|passwd|password|pwd|token|auth[_-]?token|access[_-]?token)['"]?\s*[:=]\s*)(['"])([\s\S]*?)\2/gi

export const redact = (text: string): string =>
  text
    .replace(PRIVATE_KEY_BLOCK, "[redacted-private-key]")
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(LONG_LIVED_TOKEN, "[redacted]")
    .replace(QUOTED_SECRET, "$1$2[redacted]$2")
    .replace(ASSIGNED_SECRET, "$1[redacted]")

const looksSecretive = (text: string): boolean => redact(text) !== text

const redactQuestion = (question: Question): Question => {
  if (question.type === "noul") {
    const criteria = question.criteria
    if (!criteria) return { type: "noul", instructions: redact(question.instructions) }
    return {
      type: "noul",
      instructions: redact(question.instructions),
      criteria: {
        ...(criteria.true === undefined ? {} : { true: redact(criteria.true) }),
        ...(criteria.false === undefined ? {} : { false: redact(criteria.false) }),
      },
    }
  }
  if (question.type === "choice") {
    return {
      type: "choice",
      instructions: redact(question.instructions),
      criteria: Object.fromEntries(
        Object.entries(question.criteria).map(([choice, rubric]) => [choice, rubric === null ? null : redact(rubric)]),
      ),
    }
  }
  return {
    type: "score",
    instructions: redact(question.instructions),
    criteria: question.criteria.map((entry) => redact(entry)),
  }
}

const encoder = new TextEncoder()
const utf8Bytes = (text: string): number => encoder.encode(text).length
const tokensForBytes = (bytes: number): number => Math.max(1, bytes)

const questionBytes = (id: string, question: Question): number => {
  let bytes = utf8Bytes(id) + utf8Bytes(question.instructions)
  if (question.type === "choice") {
    for (const [choice, rubric] of Object.entries(question.criteria))
      bytes += utf8Bytes(choice) + (rubric === null ? 0 : utf8Bytes(rubric))
  } else if (question.type === "score") {
    for (const entry of question.criteria) bytes += utf8Bytes(entry)
  } else if (question.criteria) {
    if (question.criteria.true !== undefined) bytes += utf8Bytes(question.criteria.true)
    if (question.criteria.false !== undefined) bytes += utf8Bytes(question.criteria.false)
  }
  return bytes
}

/** Byte-level upper bound, not a tokenizer-specific token count. */
export const estimateTokens = (state: string, questions: Readonly<Record<string, Question>>): number => {
  let bytes = utf8Bytes(state)
  for (const [id, question] of Object.entries(questions)) bytes += questionBytes(id, question)
  return tokensForBytes(bytes)
}

const DIRECT_JEV_MODEL = /^jev-[A-Za-z0-9.+-]+$/

export const estimatedCostFor = (model: string, backend: Backend, tokens: number): number | undefined =>
  backend === "typesafe" && DIRECT_JEV_MODEL.test(model) ? (tokens * JEV_USD_PER_MTOKEN) / 1_000_000 : undefined

const validateState = (state: unknown): string | undefined => {
  if (typeof state !== "string" || state.trim() === "" || state.length > MAX_STATE_CHARS)
    return `state must be a non-empty string of at most ${MAX_STATE_CHARS} characters`
  return undefined
}

const validateInstructions = (instructions: unknown): string | undefined => {
  if (typeof instructions !== "string" || instructions.trim() === "") return "instructions must be a non-empty string"
  if (instructions.length > MAX_INSTRUCTIONS_CHARS)
    return `instructions must be at most ${MAX_INSTRUCTIONS_CHARS} characters`
  return undefined
}

const validateQuestionID = (id: string): string | undefined => {
  if (id.trim() === "" || id.length > MAX_QUESTION_ID_CHARS)
    return "question id must be a non-blank string of at most 128 characters"
  if (looksSecretive(id)) return "question id looks secret-bearing; use a neutral id"
  return undefined
}

const validateChoiceOptions = (choices: unknown): string | undefined => {
  if (!Array.isArray(choices)) return "choices must be an array"
  if (choices.length < MIN_CHOICES || choices.length > MAX_CHOICES)
    return `choices must hold ${MIN_CHOICES}..${MAX_CHOICES} entries (got ${choices.length})`
  if (choices.some((choice) => typeof choice !== "string" || choice.trim() === ""))
    return "every choice must be a non-blank string"
  if (new Set(choices).size !== choices.length) return "choices must be unique"
  const secretive = (choices as string[]).find((choice) => looksSecretive(choice))
  if (secretive !== undefined) return "choice looks secret-bearing; use neutral labels"
  return undefined
}

const validateCriterionText = (rubric: unknown, label: string): string | undefined => {
  if (rubric !== undefined && rubric !== null && typeof rubric !== "string") return `${label} must be a string or null`
  if (typeof rubric === "string" && rubric.length > MAX_CRITERION_CHARS)
    return `${label} must be at most ${MAX_CRITERION_CHARS} characters`
  return undefined
}

const validateQuestion = (id: string, question: unknown): string | undefined => {
  const idError = validateQuestionID(id)
  if (idError) return idError
  if (!isRecord(question)) return `question ${JSON.stringify(id)} must be an object`
  if (question.type === "noul") {
    const bad = validateInstructions(question.instructions)
    if (bad) return `question ${JSON.stringify(id)}: ${bad}`
    const criteria = question.criteria
    if (criteria !== undefined) {
      if (!isRecord(criteria)) return `question ${JSON.stringify(id)}: criteria must be an object`
      const sides = criteria as Record<string, unknown>
      for (const side of ["true", "false"] as const) {
        const badSide = validateCriterionText(sides[side], `question ${JSON.stringify(id)} criteria.${side}`)
        if (badSide) return badSide
      }
      for (const key of Object.keys(sides)) {
        if (key !== "true" && key !== "false")
          return `question ${JSON.stringify(id)}: unknown criteria side ${JSON.stringify(key)}`
      }
    }
    return undefined
  }
  if (question.type === "choice") {
    const bad = validateInstructions(question.instructions)
    if (bad) return `question ${JSON.stringify(id)}: ${bad}`
    const criteria = question.criteria
    if (!isRecord(criteria)) return `question ${JSON.stringify(id)}: criteria must be an object`
    const options = Object.keys(criteria)
    const optionsError = validateChoiceOptions(options)
    if (optionsError) return `question ${JSON.stringify(id)}: ${optionsError}`
    for (const choice of options) {
      const badRubric = validateCriterionText(
        (criteria as Record<string, unknown>)[choice],
        `question ${JSON.stringify(id)} criteria[${JSON.stringify(choice)}]`,
      )
      if (badRubric) return badRubric
    }
    return undefined
  }
  if (question.type === "score") {
    const bad = validateInstructions(question.instructions)
    if (bad) return `question ${JSON.stringify(id)}: ${bad}`
    const criteria = question.criteria
    if (!Array.isArray(criteria)) return `question ${JSON.stringify(id)}: criteria must be an array`
    if (criteria.length < MIN_SCORE_CRITERIA || criteria.length > MAX_SCORE_CRITERIA)
      return `question ${JSON.stringify(id)}: criteria must hold ${MIN_SCORE_CRITERIA}..${MAX_SCORE_CRITERIA} entries (got ${criteria.length})`
    if (criteria.some((entry) => typeof entry !== "string" || entry.trim() === ""))
      return `question ${JSON.stringify(id)}: every criterion must be a non-blank string`
    if (new Set(criteria).size !== criteria.length) return `question ${JSON.stringify(id)}: criteria must be unique`
    if (criteria.some((entry) => (entry as string).length > MAX_CRITERION_CHARS))
      return `question ${JSON.stringify(id)}: criteria must be at most ${MAX_CRITERION_CHARS} characters`
    return undefined
  }
  return `question ${JSON.stringify(id)}: type must be "noul", "choice", or "score"`
}

const validateQuestions = (questions: unknown): string | undefined => {
  if (!isRecord(questions)) return "questions must be an object"
  const ids = Object.keys(questions)
  if (ids.length < 1 || ids.length > MAX_QUESTIONS)
    return `questions must hold 1..${MAX_QUESTIONS} entries (got ${ids.length})`
  for (const id of ids) {
    const bad = validateQuestion(id, (questions as Record<string, unknown>)[id])
    if (bad) return bad
  }
  return undefined
}

const validateTimeout = (timeoutMs: unknown): string | undefined => {
  if (
    timeoutMs !== undefined &&
    (!Number.isFinite(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 10_000)
  )
    return "timeoutMs must be between 1 and 10000 milliseconds"
  return undefined
}

const validateAsk = (input: AskInput): string | undefined => {
  const badState = validateState(input.state)
  if (badState) return badState
  const badQuestions = validateQuestions(input.questions)
  if (badQuestions) return badQuestions
  const stateTokens = tokensForBytes(utf8Bytes(input.state))
  let longest = 0
  let total = stateTokens
  for (const [id, question] of Object.entries(input.questions)) {
    const current = tokensForBytes(questionBytes(id, question))
    if (current > longest) longest = current
    total += current
  }
  if (stateTokens + longest > MAX_STATE_PLUS_LONGEST_TOKENS)
    return `payload exceeds ${MAX_STATE_PLUS_LONGEST_TOKENS} estimated tokens for state plus largest question`
  if (total > MAX_TOTAL_TOKENS) return `payload exceeds ${MAX_TOTAL_TOKENS} estimated tokens`
  const badTimeout = validateTimeout(input.timeoutMs)
  if (badTimeout) return badTimeout
  if (input.endpoint !== undefined && !input.fetch) return "endpoint override requires an injected fetch"
  return undefined
}

const validateDecide = (input: DecideInput): string | undefined => {
  const badState = validateState(input.state)
  if (badState) return badState
  if (typeof input.question !== "string" || input.question.trim() === "") return "question must be a non-empty string"
  if (input.question.length > MAX_INSTRUCTIONS_CHARS)
    return `question must be at most ${MAX_INSTRUCTIONS_CHARS} characters`
  const badChoices = validateChoiceOptions(input.choices)
  if (badChoices) return badChoices
  if (input.id !== undefined) {
    if (typeof input.id !== "string" || input.id.trim() === "" || input.id.length > MAX_QUESTION_ID_CHARS)
      return "id must be a non-blank string of at most 128 characters"
    if (looksSecretive(input.id)) return "id looks secret-bearing; use a neutral id"
  }
  const criteria = input.criteria
  if (criteria !== undefined) {
    if (!isRecord(criteria)) return "criteria must be an object"
    for (const choice of input.choices) {
      const rubric = (criteria as Record<string, unknown>)[choice]
      const badRubric = validateCriterionText(rubric, `criteria[${JSON.stringify(choice)}]`)
      if (badRubric) return badRubric
    }
  }
  const badTimeout = validateTimeout(input.timeoutMs)
  if (badTimeout) return badTimeout
  if (input.endpoint !== undefined && !input.fetch) return "endpoint override requires an injected fetch"
  return undefined
}

const extractUsage = (value: unknown): Usage | undefined => {
  if (!isRecord(value)) return undefined
  const pick = (key: string): number | undefined => {
    const candidate = value[key]
    return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined
  }
  const usage = { inputTokens: pick("input_tokens"), outputTokens: pick("output_tokens"), cost: pick("cost") }
  if (usage.inputTokens === undefined && usage.outputTokens === undefined && usage.cost === undefined) return undefined
  return usage
}

const checkProbabilities = (
  probabilities: unknown,
  keys: readonly string[],
): { ok: true; value: Record<string, number> } | { ok: false; message: string } => {
  if (!isRecord(probabilities)) return { ok: false, message: "answer.probabilities is not an object" }
  const parsed: Record<string, number> = Object.create(null)
  if (Object.keys(probabilities).length !== keys.length)
    return { ok: false, message: "probability keys do not match the requested choices" }
  for (const key of keys) {
    const probability = probabilities[key]
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1)
      return { ok: false, message: `invalid probability for ${JSON.stringify(key)}` }
    parsed[key] = probability
  }
  if (Math.abs(Object.values(parsed).reduce((sum, value) => sum + value, 0) - 1) > 0.02)
    return { ok: false, message: "choice probabilities do not sum to one" }
  return { ok: true, value: parsed }
}

const checkConfidence = (raw: unknown): { ok: true; value: number } | { ok: false; message: string } => {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1)
    return { ok: false, message: "answer.confidence must be a probability" }
  return { ok: true, value: raw }
}

type ParsedAnswer = { readonly answer: Answer; readonly usage?: Usage }

const parseAnswer = (
  payload: unknown,
  id: string,
  question: Question,
): { ok: true; value: ParsedAnswer } | { ok: false; message: string } => {
  if (!isRecord(payload)) return { ok: false, message: "response body is not an object" }
  const answers = payload.answers
  if (!isRecord(answers)) return { ok: false, message: "response has no answers map" }
  const answer = (answers as Record<string, unknown>)[id]
  if (!isRecord(answer)) return { ok: false, message: `response has no answer for question '${id}'` }
  if (answer.type !== question.type)
    return { ok: false, message: `answer type does not match requested ${question.type}` }
  const usage = extractUsage(payload.usage)
  const withUsage = usage ? { usage } : {}

  if (question.type === "noul") {
    if (typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
      return { ok: false, message: "answer.noul must be a probability in [0, 1]" }
    return { ok: true, value: { answer: { type: "noul", noul: answer.noul }, ...withUsage } }
  }
  if (question.type === "choice") {
    const options = Object.keys(question.criteria)
    if (typeof answer.choice !== "string") return { ok: false, message: "answer.choice is missing or not a string" }
    if (!options.includes(answer.choice))
      return { ok: false, message: "answer.choice is not one of the requested choices" }
    const selected = answer.choice
    const probabilities = checkProbabilities(answer.probabilities, options)
    if (!probabilities.ok) return probabilities
    if (options.some((option) => probabilities.value[option] > probabilities.value[selected] + 0.001))
      return { ok: false, message: "chosen option is not the highest probability" }
    const confidence = checkConfidence(answer.confidence)
    if (!confidence.ok) return confidence
    return {
      ok: true,
      value: {
        answer: { type: "choice", choice: selected, probabilities: probabilities.value, confidence: confidence.value },
        ...withUsage,
      },
    }
  }
  const levels = question.criteria.map((_, index) => String(index))
  if (
    typeof answer.score !== "number" ||
    !Number.isFinite(answer.score) ||
    answer.score < 0 ||
    answer.score > levels.length - 1
  )
    return { ok: false, message: `answer.score must be a number in [0, ${levels.length - 1}]` }
  const probabilities = checkProbabilities(answer.probabilities, levels)
  if (!probabilities.ok) return probabilities
  const confidence = checkConfidence(answer.confidence)
  if (!confidence.ok) return confidence
  if (!isRecord(answer.legend)) return { ok: false, message: "answer.legend is not an object" }
  if (Object.keys(answer.legend).length !== levels.length)
    return { ok: false, message: "answer.legend keys do not match the requested levels" }
  const legend: Record<string, string> = Object.create(null)
  for (const key of levels) {
    const value = answer.legend[key]
    if (typeof value !== "string" || value.length > MAX_CRITERION_CHARS)
      return {
        ok: false,
        message: `answer.legend[${JSON.stringify(key)}] must be a string of at most ${MAX_CRITERION_CHARS} characters`,
      }
    legend[key] = value
  }
  return {
    ok: true,
    value: {
      answer: {
        type: "score",
        score: answer.score,
        legend,
        probabilities: probabilities.value,
        confidence: confidence.value,
      },
      ...withUsage,
    },
  }
}

interface CacheEntry {
  readonly expiresAt: number
  readonly answers: Readonly<Record<string, Answer>>
  readonly usage?: Usage
  readonly backend: Backend
  readonly model: string
}

const cache = new Map<string, CacheEntry>()

interface TaskEntry {
  readonly shared: Promise<SharedOutcome>
  readonly control: { consumers: number; abort: () => void }
}

const inflight = new Map<string, TaskEntry>()
let semaphoreCount = 0
let requestTimes: number[] = []
let tokenUses: Array<{ at: number; tokens: number }> = []
const fetchIds = new WeakMap<Function, number>()
let nextFetchId = 1

export const resetJevStateForTests = (): void => {
  cache.clear()
  inflight.clear()
  semaphoreCount = 0
  requestTimes = []
  tokenUses = []
  JevLedger.resetForTests()
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

const resolveClientOptions = (
  config: Config | undefined,
): {
  maxInflight: number
  requestsPerMinute: number
  tokensPerMinute: number
  cacheMaxEntries: number
  cacheTtlMs: number
  retries: number
} => {
  const client = config?.banyancode_jev_client ?? {}
  return {
    maxInflight: clampInt(client.maxInflight, 1, 32, DEFAULT_MAX_INFLIGHT),
    requestsPerMinute: clampInt(client.requestsPerMinute, 1, 1200, DEFAULT_REQUESTS_PER_MINUTE),
    tokensPerMinute: clampInt(client.tokensPerMinute, 1000, 1_000_000, DEFAULT_TOKENS_PER_MINUTE),
    cacheMaxEntries: clampInt(client.cacheMaxEntries, 0, 1024, DEFAULT_CACHE_MAX_ENTRIES),
    cacheTtlMs: clampInt(client.cacheTtlMs, 0, 3_600_000, DEFAULT_CACHE_TTL_MS),
    retries: clampInt(client.retries, 0, 5, DEFAULT_RETRIES),
  }
}

const resolveBudget = (config: Config | undefined): { perTurnCalls?: number; perSessionUsd?: number } => {
  const budget = config?.banyancode_jev_budget ?? {}
  const perTurnCalls =
    typeof budget.perTurnCalls === "number" &&
    Number.isFinite(budget.perTurnCalls) &&
    Math.floor(budget.perTurnCalls) >= 1
      ? Math.floor(budget.perTurnCalls)
      : undefined
  const perSessionUsd =
    typeof budget.perSessionUsd === "number" && Number.isFinite(budget.perSessionUsd) && budget.perSessionUsd >= 0
      ? budget.perSessionUsd
      : undefined
  return {
    ...(perTurnCalls === undefined ? {} : { perTurnCalls }),
    ...(perSessionUsd === undefined ? {} : { perSessionUsd }),
  }
}

const fetchIdentity = (fetch: Fetch | undefined): string => {
  if (fetch === undefined) return "default"
  let id = fetchIds.get(fetch)
  if (id === undefined) {
    id = nextFetchId
    nextFetchId += 1
    fetchIds.set(fetch, id)
  }
  return `injected:${id}`
}

const cacheKeyFor = (parts: {
  state: string
  questions: Readonly<Record<string, Question>>
  backend: Backend
  model: string
  endpoint: string
  keyDigest: string
  fetchId: string
  sessionID: string
  timeoutMs: number
  retries: number
}): string => {
  const sorted: Record<string, Question> = Object.create(null)
  for (const id of Object.keys(parts.questions).sort()) sorted[id] = parts.questions[id]
  return createHash("sha256")
    .update(JSON.stringify({ ...parts, questions: sorted }))
    .digest("hex")
}

const readCache = (key: string): CacheEntry | undefined => {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key)
    return undefined
  }
  cache.delete(key)
  cache.set(key, entry)
  return entry
}

const writeCache = (key: string, maxEntries: number, ttlMs: number, value: Omit<CacheEntry, "expiresAt">): void => {
  if (maxEntries <= 0 || ttlMs <= 0) return
  cache.delete(key)
  cache.set(key, { ...value, expiresAt: Date.now() + ttlMs })
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

const pruneWindows = (now: number): void => {
  requestTimes = requestTimes.filter((at) => now - at < 60_000)
  tokenUses = tokenUses.filter((use) => now - use.at < 60_000)
}

type SharedOutcome =
  | {
      readonly ok: true
      readonly answers: Readonly<Record<string, Answer>>
      readonly usage?: Usage
      readonly backend: Backend
      readonly model: string
    }
  | {
      readonly ok: false
      readonly reason: Failure
      readonly message: string
      readonly status?: number
      readonly backend: Backend
    }

const parseRetryAfterMs = (response: Response): number | undefined => {
  const raw = response.headers.get("retry-after")
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (trimmed === "") return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const when = Date.parse(trimmed)
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now())
}

const abortableSleep = (ms: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolveSleep) => {
    if (signal.aborted) {
      resolveSleep(false)
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolveSleep(true)
    }, ms)
    const onAbort = (): void => {
      cleanup()
      resolveSleep(false)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })

interface PhysicalParams {
  url: string
  apiKey: string
  body: string
  fetcher: Fetch
  deadline: number
  backend: Backend
  model: string
  sessionID: string
  retries: number
  questions: Readonly<Record<string, Question>>
  signal: AbortSignal
  estimatedTokens: number
  estCost: number | undefined
  usdCap: number | undefined
  maxRequestsPerMinute: number
  maxTokensPerMinute: number
}

const runPhysical = async (params: PhysicalParams): Promise<SharedOutcome> => {
  let attempt = 0
  for (;;) {
    if (params.signal.aborted)
      return { ok: false, reason: "cancelled", message: "Jev request was cancelled", backend: params.backend }
    const remaining = params.deadline - Date.now()
    if (remaining <= 0)
      return { ok: false, reason: "timeout", message: "Jev request timed out", backend: params.backend }
    const now = Date.now()
    pruneWindows(now)
    if (requestTimes.length >= params.maxRequestsPerMinute)
      return { ok: false, reason: "rate-limited", message: "Jev request rate budget exceeded", backend: params.backend }
    if (tokenUses.reduce((sum, use) => sum + use.tokens, 0) + params.estimatedTokens > params.maxTokensPerMinute)
      return { ok: false, reason: "rate-limited", message: "Jev token rate budget exceeded", backend: params.backend }
    if (params.usdCap !== undefined && params.estCost === undefined)
      return { ok: false, reason: "budget-exceeded", message: "Jev model pricing is unknown", backend: params.backend }
    const reserveAmount = params.estCost ?? 0
    const acquired =
      params.estCost !== undefined ? JevLedger.reserveCost(params.sessionID, params.estCost, params.usdCap) : true
    if (!acquired)
      return {
        ok: false,
        reason: "budget-exceeded",
        message: "Jev per-session budget exceeded",
        backend: params.backend,
      }
    let settled = false
    const settleRelease = (): void => {
      if (params.estCost === undefined || settled) return
      settled = true
      JevLedger.releaseCost(params.sessionID, params.estCost)
    }
    const settleSpend = (amount: number): void => {
      if (settled) return
      settled = true
      if (params.estCost === undefined) {
        if (amount > 0) JevLedger.recordEstimatedSpend(params.sessionID, amount, { reservedCost: 0 })
        return
      }
      JevLedger.recordEstimatedSpend(params.sessionID, amount, { reservedCost: params.estCost })
    }
    const settleUsage = (usage: Usage): void => {
      if (settled) return
      settled = true
      if (usage.cost !== undefined) {
        JevLedger.recordUsage(params.sessionID, {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cost: usage.cost,
          reservedCost: params.estCost,
        })
        return
      }
      const derived =
        usage.inputTokens !== undefined ? estimatedCostFor(params.model, params.backend, usage.inputTokens) : undefined
      const spend = derived ?? params.estCost ?? 0
      if (spend > 0) {
        JevLedger.recordUsage(params.sessionID, {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          estimatedCost: spend,
          reservedCost: params.estCost,
        })
        return
      }
      if (params.estCost !== undefined) JevLedger.releaseCost(params.sessionID, params.estCost)
    }
    requestTimes.push(now)
    tokenUses.push({ at: now, tokens: params.estimatedTokens })
    JevLedger.recordAttempt(params.sessionID)
    const combined = new AbortController()
    const timer = setTimeout(
      () => combined.abort(new DOMException("timed out", "TimeoutError")),
      Math.max(1, remaining),
    )
    const onShared = (): void => {
      combined.abort(params.signal.reason ?? new DOMException("cancelled", "AbortError"))
    }
    params.signal.addEventListener("abort", onShared, { once: true })
    try {
      const response = await withAbort(
        params.fetcher(params.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${params.apiKey}`, "Content-Type": "application/json" },
          body: params.body,
          signal: combined.signal,
        }),
        combined.signal,
      )
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500
        if (retryable && attempt < params.retries) {
          attempt += 1
          // Known HTTP error: unbilled, release this attempt's reservation before retry.
          const waitMs = parseRetryAfterMs(response)
          const left = params.deadline - Date.now()
          if (waitMs === undefined) {
            const backoff = Math.min(150 * 2 ** (attempt - 1), left)
            settleRelease()
            if (backoff <= 0)
              return { ok: false, reason: "timeout", message: "Jev request timed out", backend: params.backend }
            if (!(await abortableSleep(backoff, params.signal)))
              return { ok: false, reason: "cancelled", message: "Jev request was cancelled", backend: params.backend }
            continue
          }
          if (waitMs > left) {
            settleRelease()
            return {
              ok: false,
              reason: "timeout",
              message: "Jev Retry-After exceeds the request deadline",
              backend: params.backend,
            }
          }
          try {
            await withAbort(response.arrayBuffer(), combined.signal)
          } catch {
            settleSpend(reserveAmount)
            if (params.signal.aborted)
              return { ok: false, reason: "cancelled", message: "Jev request was cancelled", backend: params.backend }
            return { ok: false, reason: "timeout", message: "Jev request timed out", backend: params.backend }
          }
          settleRelease()
          if (!(await abortableSleep(waitMs, params.signal)))
            return { ok: false, reason: "cancelled", message: "Jev request was cancelled", backend: params.backend }
          continue
        }
        // Terminal HTTP failure (429/401/422/4xx/5xx): unsuccessful, release unbilled estimate.
        settleRelease()
        return {
          ok: false,
          reason: "http-error",
          message: `Jev returned HTTP ${response.status}`,
          backend: params.backend,
          status: response.status,
        }
      }
      const payload: unknown = await withAbort(response.json(), combined.signal).catch((cause) => {
        if (combined.signal.aborted) throw cause
        return undefined
      })
      if (payload === undefined) {
        // 2xx with unparseable body: may be billed, retain conservative spend.
        settleSpend(reserveAmount)
        return { ok: false, reason: "invalid-answer", message: "Jev response was not JSON", backend: params.backend }
      }
      const answers: Record<string, Answer> = Object.create(null)
      let mergedUsage: Usage | undefined
      for (const [id, question] of Object.entries(params.questions)) {
        const parsed = parseAnswer(payload, id, question)
        if (!parsed.ok) {
          settleSpend(reserveAmount)
          return { ok: false, reason: "invalid-answer", message: parsed.message, backend: params.backend }
        }
        answers[id] = parsed.value.answer
        if (parsed.value.usage) mergedUsage = parsed.value.usage
      }
      if (mergedUsage) settleUsage(mergedUsage)
      else settleSpend(reserveAmount)
      return {
        ok: true,
        answers,
        ...(mergedUsage ? { usage: mergedUsage } : {}),
        backend: params.backend,
        model: isRecord(payload) && typeof payload.model === "string" ? payload.model : params.model,
      }
    } catch (cause) {
      if (params.signal.aborted) {
        settleSpend(reserveAmount)
        return { ok: false, reason: "cancelled", message: "Jev request was cancelled", backend: params.backend }
      }
      if (isAbort(cause)) {
        settleSpend(reserveAmount)
        return { ok: false, reason: "timeout", message: "Jev request timed out", backend: params.backend }
      }
      if (attempt < params.retries) {
        attempt += 1
        // Ambiguous network failure: may be charged, retain conservative spend before retry.
        settleSpend(reserveAmount)
        const backoff = Math.min(150 * 2 ** (attempt - 1), params.deadline - Date.now())
        if (backoff <= 0)
          return { ok: false, reason: "timeout", message: "Jev request timed out", backend: params.backend }
        if (!(await abortableSleep(backoff, params.signal)))
          return { ok: false, reason: "cancelled", message: "Jev request was cancelled", backend: params.backend }
        continue
      }
      settleSpend(reserveAmount)
      return { ok: false, reason: "network", message: "Jev network request failed", backend: params.backend }
    } finally {
      clearTimeout(timer)
      params.signal.removeEventListener("abort", onShared)
      // Unconditional release exactly once per attempt: converts above settle
      // calls into no-ops here; unsettled attempts free pending here.
      if (params.estCost !== undefined && !settled) {
        settled = true
        JevLedger.releaseCost(params.sessionID, params.estCost)
      }
    }
  }
}

const withAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("cancelled", "AbortError"))
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (cause) => {
        signal.removeEventListener("abort", onAbort)
        reject(cause)
      },
    )
  })

interface ExecuteParams extends PhysicalParams {
  maxInflight: number
  cacheKey: string | undefined
  cacheMaxEntries: number
  cacheTtlMs: number
}

const executePhysical = async (params: ExecuteParams): Promise<SharedOutcome> => {
  if (semaphoreCount >= params.maxInflight)
    return { ok: false, reason: "rate-limited", message: "Jev concurrency budget exceeded", backend: params.backend }
  semaphoreCount += 1
  try {
    const outcome = await runPhysical(params)
    if (outcome.ok && params.cacheKey) {
      writeCache(params.cacheKey, params.cacheMaxEntries, params.cacheTtlMs, {
        answers: outcome.answers,
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        backend: outcome.backend,
        model: outcome.model,
      })
    }
    return outcome
  } finally {
    semaphoreCount -= 1
  }
}

const joinShared = (
  shared: Promise<SharedOutcome>,
  signal: AbortSignal | undefined,
  callerDeadline: number,
): Promise<SharedOutcome | { readonly settled: "cancelled" } | { readonly settled: "timeout" }> => {
  if (signal?.aborted) return Promise.resolve({ settled: "cancelled" as const })
  const remaining = callerDeadline - Date.now()
  if (remaining <= 0) return Promise.resolve({ settled: "timeout" as const })
  return new Promise((resolveJoin) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      cleanup()
      resolveJoin({ settled: "timeout" as const })
    }, remaining)
    const onAbort = (): void => {
      if (done) return
      done = true
      cleanup()
      resolveJoin({ settled: "cancelled" as const })
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    void shared.then(
      (outcome) => {
        if (done) return
        done = true
        cleanup()
        resolveJoin(outcome)
      },
      () => {
        if (done) return
        done = true
        cleanup()
        resolveJoin({ settled: "timeout" as const })
      },
    )
  })
}

export const ask = async (input: AskInput): Promise<AskResult> => {
  const started = Date.now()
  if (!isRecord(input))
    return {
      ok: false,
      reason: "invalid-input",
      message: "input must be an object",
      backend: DEFAULT_BACKEND,
      latencyMs: 0,
    }
  const config = input.config ?? {}
  const backend = input.backend ?? config.banyancode_jev_backend ?? DEFAULT_BACKEND
  if (!BACKENDS.includes(backend))
    return {
      ok: false,
      reason: "invalid-input",
      message: "unknown Jev backend",
      backend: DEFAULT_BACKEND,
      latencyMs: 0,
    }
  const model = input.model ?? config.banyancode_jev_model ?? DEFAULT_MODELS[backend]
  const fail = (reason: Failure, message: string, status?: number): AskResult => ({
    ok: false,
    reason,
    message,
    backend,
    latencyMs: Date.now() - started,
    ...(status === undefined ? {} : { status }),
  })

  if (input.apiKey !== undefined && typeof input.apiKey !== "string")
    return fail("invalid-input", "apiKey must be a string")
  if (typeof model !== "string" || model.trim() === "") return fail("invalid-input", "model must be a non-empty string")
  if (input.fetch !== undefined && typeof input.fetch !== "function")
    return fail("invalid-input", "fetch must be a function")
  if (
    input.signal !== undefined &&
    (!input.signal ||
      typeof input.signal.addEventListener !== "function" ||
      typeof input.signal.removeEventListener !== "function")
  )
    return fail("invalid-input", "signal must support cancellation")

  if (input.signal?.aborted) return fail("cancelled", "Jev request was cancelled before it started")
  if (config.banyancode_jev_enabled === false)
    return fail("disabled", "Jev is disabled by banyancode_jev_enabled=false")
  const apiKey = input.apiKey?.trim() || keyFor(backend, input.env ?? process.env)
  if (!apiKey) return fail("missing-key", `no Jev API key: set BANYANCODE_JEV_API_KEY or connect ${backend}`)
  if (!input.apiKey && !resolve({ ...config, banyancode_jev_backend: backend }, input.env ?? process.env).enabled)
    return fail("disabled", "Jev requires an explicit connection for this backend")
  const invalid = validateAsk(input as AskInput)
  if (invalid) return fail("invalid-input", invalid)

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const sessionID = input.sessionID?.trim() || DEFAULT_SESSION_ID
  const scope = input.scope?.trim() || DEFAULT_SCOPE
  const client = resolveClientOptions(config)
  const budget = resolveBudget(config)

  const redactedState = redact(input.state)
  const redactedQuestions: Record<string, Question> = Object.create(null)
  for (const [id, question] of Object.entries(input.questions)) redactedQuestions[id] = redactQuestion(question)
  const estimatedTokens = estimateTokens(redactedState, redactedQuestions)
  const estCost = estimatedCostFor(model, backend, estimatedTokens)

  const cacheable = client.cacheMaxEntries > 0 && client.cacheTtlMs > 0
  const url = input.endpoint ?? ENDPOINTS[backend]
  const key = cacheable
    ? cacheKeyFor({
        state: redactedState,
        questions: redactedQuestions,
        backend,
        model,
        endpoint: url,
        keyDigest: createHash("sha256").update(apiKey).digest("hex"),
        fetchId: fetchIdentity(input.fetch),
        sessionID,
        timeoutMs,
        retries: client.retries,
      })
    : undefined
  if (key) {
    const hit = readCache(key)
    if (hit) {
      JevLedger.recordCacheHit(sessionID, input.feature === undefined ? undefined : { feature: input.feature })
      return {
        ok: true,
        answers: hit.answers,
        backend: hit.backend,
        model: hit.model,
        latencyMs: Date.now() - started,
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        cached: true,
      }
    }
  }

  if (budget.perTurnCalls !== undefined && JevLedger.scopeCount(sessionID, scope) >= budget.perTurnCalls)
    return fail(
      "budget-exceeded",
      `Jev per-turn budget exceeded (${budget.perTurnCalls} calls in scope ${JSON.stringify(scope)})`,
    )
  JevLedger.reserveCall(sessionID, {
    ...(input.feature === undefined ? {} : { feature: input.feature }),
    scope,
  })

  const callerDeadline = started + timeoutMs
  const body = JSON.stringify({
    state: redactedState,
    model,
    questions: Object.fromEntries(
      Object.entries(redactedQuestions).map(([id, question]) => {
        if (question.type === "noul")
          return [
            id,
            {
              type: "noul" as const,
              instructions: question.instructions,
              ...(question.criteria ? { criteria: question.criteria } : {}),
            },
          ]
        if (question.type === "choice")
          return [id, { type: "choice" as const, instructions: question.instructions, criteria: question.criteria }]
        return [id, { type: "score" as const, instructions: question.instructions, criteria: question.criteria }]
      }),
    ),
  })

  let entry = key !== undefined ? inflight.get(key) : undefined
  const reused = entry !== undefined
  if (!entry) {
    const controller = new AbortController()
    const control = {
      consumers: 0,
      abort: (): void => {
        controller.abort(new DOMException("cancelled", "AbortError"))
      },
    }
    const created: TaskEntry = {
      control,
      shared: executePhysical({
        url,
        apiKey,
        body,
        fetcher: input.fetch ?? fetch,
        deadline: callerDeadline,
        backend,
        model,
        sessionID,
        retries: client.retries,
        questions: redactedQuestions,
        signal: controller.signal,
        estimatedTokens,
        estCost,
        usdCap: budget.perSessionUsd,
        maxRequestsPerMinute: client.requestsPerMinute,
        maxTokensPerMinute: client.tokensPerMinute,
        maxInflight: client.maxInflight,
        cacheKey: key,
        cacheMaxEntries: client.cacheMaxEntries,
        cacheTtlMs: client.cacheTtlMs,
      }),
    }
    created.shared.finally(() => {
      if (key !== undefined && inflight.get(key) === created) inflight.delete(key)
    })
    entry = created
    if (key !== undefined) inflight.set(key, created)
  }
  entry.control.consumers += 1
  const joined = await joinShared(entry.shared, input.signal, callerDeadline)
  entry.control.consumers -= 1
  if (entry.control.consumers <= 0) {
    // Eagerly drop a cancelled/timed-out entry so the immediate next request
    // starts a fresh physical instead of joining a doomed shared. The await
    // below still bounds permit cleanup (withAbort covers fetch/body).
    if (key !== undefined && !("ok" in joined) && inflight.get(key) === entry) inflight.delete(key)
    entry.control.abort()
    if (!("ok" in joined)) await entry.shared.catch(() => undefined)
  }
  if (!("ok" in joined)) {
    return joined.settled === "cancelled"
      ? fail("cancelled", "Jev request was cancelled")
      : fail("timeout", "Jev request timed out")
  }
  if (!joined.ok) return { ...joined, latencyMs: Date.now() - started }
  if (reused) JevLedger.recordCacheHit(sessionID)
  return {
    ok: true,
    answers: joined.answers,
    backend: joined.backend,
    model: joined.model,
    latencyMs: Date.now() - started,
    ...(reused ? { usage: { inputTokens: 0, outputTokens: 0, cost: 0 } } : joined.usage ? { usage: joined.usage } : {}),
    cached: reused,
  }
}

export const decide = async (input: DecideInput): Promise<DecideResult> => {
  const started = Date.now()
  if (!isRecord(input))
    return {
      ok: false,
      reason: "invalid-input",
      message: "input must be an object",
      backend: DEFAULT_BACKEND,
      latencyMs: 0,
    }
  const typed = input as DecideInput
  const invalid = validateDecide(typed)
  const backend = typed.backend ?? typed.config?.banyancode_jev_backend ?? DEFAULT_BACKEND
  if (invalid)
    return {
      ok: false,
      reason: "invalid-input",
      message: invalid,
      backend,
      latencyMs: Date.now() - started,
    }
  const id = typed.id ?? DEFAULT_QUESTION_ID
  const criteria = Object.fromEntries(typed.choices.map((choice) => [choice, typed.criteria?.[choice] ?? null]))
  const result = await ask({
    state: typed.state,
    questions: { [id]: { type: "choice", instructions: typed.question, criteria } },
    config: typed.config,
    backend: typed.backend,
    model: typed.model,
    apiKey: typed.apiKey,
    endpoint: typed.endpoint,
    timeoutMs: typed.timeoutMs,
    env: typed.env,
    fetch: typed.fetch,
    signal: typed.signal,
    sessionID: typed.sessionID,
    feature: typed.feature ?? "judge",
    scope: typed.scope,
  })
  if (!result.ok)
    return {
      ok: false,
      reason: result.reason,
      message: result.message,
      backend: result.backend,
      latencyMs: result.latencyMs,
      ...(result.status === undefined ? {} : { status: result.status }),
    }
  const answer = result.answers[id]
  if (!answer || answer.type !== "choice")
    return {
      ok: false,
      reason: "invalid-answer",
      message: `response has no answer for question '${id}'`,
      backend: result.backend,
      latencyMs: result.latencyMs,
    }
  return {
    ok: true,
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    backend: result.backend,
    model: result.model,
    latencyMs: result.latencyMs,
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.cached === undefined ? {} : { cached: result.cached }),
  }
}

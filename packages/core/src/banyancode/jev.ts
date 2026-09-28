export * as Jev from "./jev"

import type { Info as BanyanConfigInfo } from "../v1/config/banyan-config"

// Jev (TypeSafe "System One") HTTP decision client.
//
// Jev never generates text: POST a `state` plus typed questions, get back
// probabilities over a bounded option set (docs.typesafe.ai/api).
// Only enumerable, no-writing decisions belong here — the LLM stays planner
// and writer. `decide` NEVER throws: every failure is a structured
// `{ ok: false, reason }` result, so callers fail safe and escalate the
// decision back to the LLM (the jev-use escalate contract: on any non-ok,
// treat the question as unanswered and route it to the model or the user).
//
// API: `Jev.decide(input) -> Promise<DecideResult>`; `Jev.resolve` /
// `Jev.isEnabled` expose the enable/key/backend resolution without calling
// the network. No rate limiting, caching, or retries yet — one bounded
// request per call, fail safe.
//
// Backends (all speak the TypeSafe `POST .../v1/systemone` request/response
// shape; see ENDPOINTS / KEY_ENV):
//   typesafe   https://api.typesafe.ai/v1/systemone               BANYANCODE_JEV_API_KEY | TYPESAFE_API_KEY
//   openrouter https://openrouter.ai/api/v1/systemone             BANYANCODE_JEV_API_KEY
//   vercel     https://ai-gateway.vercel.sh/typesafe/v1/systemone BANYANCODE_JEV_API_KEY
//
// Config (`BanyanConfig.Info`, passed via `input.config`):
//   banyancode_jev_enabled  explicit false disables even with a key present;
//                           generic gateway credentials are never reused.
//   banyancode_jev_backend  "typesafe" (default) | "openrouter" | "vercel"
//   banyancode_jev_model    per-backend default when unset
//
// v1 credentials come from env ONLY. Storing/retrieving a Jev credential via
// Auth.Service (`core/src/auth.ts:113-179`) is deliberately deferred.
//
// Effect callers: `decide` never rejects, so
// `Effect.promise(() => Jev.decide(...))` cannot die on rejection; branch on
// `result.ok` and escalate on `ok: false`.

export type Backend = "typesafe" | "openrouter" | "vercel"

export const BACKENDS = ["typesafe", "openrouter", "vercel"] as const

export const DEFAULT_BACKEND: Backend = "typesafe"

/** Default model id per backend (docs.typesafe.ai/models, openrouter /systemone, vercel typesafe-compatible API). */
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

/** Env vars consulted per backend, in order; first non-blank wins. */
export const KEY_ENV: Record<Backend, readonly string[]> = {
  typesafe: ["BANYANCODE_JEV_API_KEY", "TYPESAFE_API_KEY"],
  openrouter: ["BANYANCODE_JEV_API_KEY"],
  vercel: ["BANYANCODE_JEV_API_KEY"],
}

/** A Choice carries at least 2 and at most 255 options (docs.typesafe.ai/api). */
export const MIN_CHOICES = 2
export const MAX_CHOICES = 255
export const DEFAULT_QUESTION_ID = "decision"
export const DEFAULT_TIMEOUT_MS = 5_000

export type Env = Record<string, string | undefined>

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type Config = Pick<
  BanyanConfigInfo,
  "banyancode_jev_enabled" | "banyancode_jev_backend" | "banyancode_jev_model"
>

export type DecideFailure =
  | "disabled"
  | "missing-key"
  | "invalid-input"
  | "http-error"
  | "timeout"
  | "network"
  | "invalid-answer"

export interface DecideSuccess {
  readonly ok: true
  /** The highest-probability option; always one of the requested `choices`. */
  readonly choice: string
  readonly confidence: number
  readonly probabilities: Readonly<Record<string, number>>
  readonly backend: Backend
  readonly model: string
  readonly latencyMs: number
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cost?: number
  }
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

export interface DecideInput {
  /** The facts the decision is about (bounded locally before network access). */
  readonly state: string
  /** The decision phrased about `state`. */
  readonly question: string
  /** Mutually exclusive answers: 2..255 non-blank, unique strings. */
  readonly choices: readonly string[]
  /** Per-choice rubric text; defaults to null for every choice. */
  readonly criteria?: Readonly<Record<string, string | null | undefined>>
  /** Question id echoed in the response `answers` map; default "decision". */
  readonly id?: string
  /** BanyanConfig.Info (or its Jev subset); explicit fields below win. */
  readonly config?: Config
  /** Wins over `config.banyancode_jev_backend`. */
  readonly backend?: Backend
  /** Wins over `config.banyancode_jev_model`. */
  readonly model?: string
  /** Explicit caller-provided credential; supplying it counts as connecting Jev. */
  readonly apiKey?: string
  /** Test-only endpoint override; requires an injected fetch implementation. */
  readonly endpoint?: string
  /** Positive abort budget in ms. Default DEFAULT_TIMEOUT_MS. */
  readonly timeoutMs?: number
  readonly env?: Env
  readonly fetch?: Fetch
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const nameOf = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "name" in cause && typeof cause.name === "string"
    ? cause.name
    : undefined

const isAbort = (cause: unknown): boolean => nameOf(cause) === "TimeoutError" || nameOf(cause) === "AbortError"

export const keyFor = (backend: Backend, env: Env = process.env): string | undefined =>
  KEY_ENV[backend]
    .map((name) => env[name]?.trim())
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

/** True only when a key and an explicit Jev connection are present. */
export const isEnabled = (config: Config = {}, env: Env = process.env): boolean => resolve(config, env).enabled

const validate = (input: DecideInput): string | undefined => {
  if (typeof input.state !== "string" || input.state.trim() === "" || input.state.length > 120_000)
    return "state must be a non-empty string of at most 120000 characters"
  if (typeof input.question !== "string" || input.question.trim() === "")
    return "question must be a non-empty string"
  if (input.question.length > 8_000) return "question must be at most 8000 characters"
  const choices = input.choices
  if (!Array.isArray(choices)) return "choices must be an array"
  if (choices.length < MIN_CHOICES || choices.length > MAX_CHOICES)
    return `choices must hold ${MIN_CHOICES}..${MAX_CHOICES} entries (got ${choices.length})`
  if (choices.some((choice) => typeof choice !== "string" || choice.trim() === ""))
    return "every choice must be a non-blank string"
  if (new Set(choices).size !== choices.length) return "choices must be unique"
  if (
    input.id !== undefined &&
    (typeof input.id !== "string" || input.id.trim() === "" || input.id.length > 128)
  )
    return "id must be a non-blank string of at most 128 characters"
  const criteria = input.criteria
  if (criteria !== undefined) {
    if (!isRecord(criteria)) return "criteria must be an object"
    for (const choice of choices) {
      const rubric = criteria[choice]
      if (rubric !== undefined && rubric !== null && typeof rubric !== "string")
        return `criteria[${JSON.stringify(choice)}] must be a string or null`
      if (typeof rubric === "string" && rubric.length > 2_000)
        return `criteria[${JSON.stringify(choice)}] must be at most 2000 characters`
    }
  }
  if (input.endpoint !== undefined && !input.fetch) return "endpoint override requires an injected fetch"
  if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 10_000))
    return "timeoutMs must be between 1 and 10000 milliseconds"
  return undefined
}

type ParsedAnswer = {
  readonly choice: string
  readonly confidence: number
  readonly probabilities: Readonly<Record<string, number>>
  readonly usage?: DecideSuccess["usage"]
}

const extractUsage = (value: unknown): DecideSuccess["usage"] => {
  if (!isRecord(value)) return undefined
  const pick = (key: string): number | undefined => {
    const candidate = value[key]
    return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined
  }
  const usage = { inputTokens: pick("input_tokens"), outputTokens: pick("output_tokens"), cost: pick("cost") }
  if (usage.inputTokens === undefined && usage.outputTokens === undefined && usage.cost === undefined)
    return undefined
  return usage
}

const extract = (
  payload: unknown,
  id: string,
  choices: readonly string[],
): { ok: true; value: ParsedAnswer } | { ok: false; message: string } => {
  if (!isRecord(payload)) return { ok: false, message: "response body is not an object" }
  const answers = payload.answers
  if (!isRecord(answers)) return { ok: false, message: "response has no answers map" }
  const answer = answers[id]
  if (!isRecord(answer)) return { ok: false, message: `response has no answer for question '${id}'` }
  if (answer.type !== "choice")
    return { ok: false, message: `answer type is ${JSON.stringify(answer.type)}, expected "choice"` }
  if (typeof answer.choice !== "string") return { ok: false, message: "answer.choice is missing or not a string" }
  if (!choices.includes(answer.choice))
    return { ok: false, message: `answer ${JSON.stringify(answer.choice)} is not one of the requested choices` }
  const selected = answer.choice
  if (!isRecord(answer.probabilities)) return { ok: false, message: "answer.probabilities is not an object" }
  const probabilities: Record<string, number> = Object.create(null)
  if (Object.keys(answer.probabilities).length !== choices.length)
    return { ok: false, message: "probability keys do not match the requested choices" }
  for (const choice of choices) {
    const probability = answer.probabilities[choice]
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1)
      return { ok: false, message: `invalid probability for ${JSON.stringify(choice)}` }
    probabilities[choice] = probability
  }
  if (Math.abs(Object.values(probabilities).reduce((sum, value) => sum + value, 0) - 1) > 0.02)
    return { ok: false, message: "choice probabilities do not sum to one" }
  if (choices.some((choice) => probabilities[choice] > probabilities[selected] + 0.001))
    return { ok: false, message: "chosen option is not the highest probability" }
  const rawConfidence = answer.confidence
  if (typeof rawConfidence !== "number" || !Number.isFinite(rawConfidence) || rawConfidence < 0 || rawConfidence > 1)
    return { ok: false, message: "answer.confidence must be a probability" }
  const usage = extractUsage(payload.usage)
  return {
    ok: true,
    value: { choice: selected, confidence: rawConfidence, probabilities, ...(usage ? { usage } : {}) },
  }
}

/**
 * Ask Jev one bounded Choice question. Never throws; never rejects.
 * On `ok: false`, fail safe: skip the automated action and escalate the
 * decision back to the LLM / the user.
 */
export const decide = async (input: DecideInput): Promise<DecideResult> => {
  const started = Date.now()
  if (!isRecord(input))
    return { ok: false, reason: "invalid-input", message: "input must be an object", backend: DEFAULT_BACKEND, latencyMs: 0 }
  const config = input.config ?? {}
  const backend = input.backend ?? config.banyancode_jev_backend ?? DEFAULT_BACKEND
  const model = input.model ?? config.banyancode_jev_model ?? DEFAULT_MODELS[backend]
  const apiKey = input.apiKey?.trim() || keyFor(backend, input.env ?? process.env)
  const fail = (reason: DecideFailure, message: string, status?: number): DecideResult => ({
    ok: false,
    reason,
    message,
    backend,
    latencyMs: Date.now() - started,
    ...(status === undefined ? {} : { status }),
  })

  if (config.banyancode_jev_enabled === false)
    return fail("disabled", "Jev is disabled by banyancode_jev_enabled=false")
  if (!apiKey) return fail("missing-key", `no Jev API key: set BANYANCODE_JEV_API_KEY or connect ${backend}`)
  if (!input.apiKey && !resolve({ ...config, banyancode_jev_backend: backend }, input.env ?? process.env).enabled)
    return fail("disabled", "Jev requires an explicit connection for this backend")
  const invalid = validate(input)
  if (invalid) return fail("invalid-input", invalid)

  const id = input.id ?? DEFAULT_QUESTION_ID
  const criteria = Object.fromEntries(input.choices.map((choice) => [choice, input.criteria?.[choice] ?? null]))
  const body = JSON.stringify({
    state: input.state,
    model,
    questions: { [id]: { type: "choice", instructions: input.question, criteria } },
  })
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const signal = AbortSignal.timeout(timeoutMs)
  const fetcher: Fetch = input.fetch ?? fetch

  let response: Response
  try {
    response = await fetcher(input.endpoint ?? ENDPOINTS[backend], {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body,
      signal,
    })
  } catch (cause) {
    return fail(
      isAbort(cause) ? "timeout" : "network",
      isAbort(cause) ? "Jev request timed out" : "Jev network request failed",
    )
  }

  if (!response.ok) {
    return fail("http-error", `Jev returned HTTP ${response.status}`, response.status)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return fail("invalid-answer", "Jev response was not JSON")
  }

  const parsed = extract(payload, id, input.choices)
  if (!parsed.ok) return fail("invalid-answer", parsed.message)
  return {
    ok: true,
    ...parsed.value,
    backend,
    model: isRecord(payload) && typeof payload.model === "string" ? payload.model : model,
    latencyMs: Date.now() - started,
  }
}

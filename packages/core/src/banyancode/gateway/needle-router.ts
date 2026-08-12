export * as RepositoryGatewayNeedle from "./needle-router"

import { Context, Effect, Layer, Option } from "effect"
import type { Relation, RepositoryOperation, RouteDecision, RouterInput, ToolRouter } from "./types"

// Needle 2 router (plan §3, spec §12-13, §24, §35, §73). The learned
// classifier path of the RepositoryGateway: a compact local model that maps a
// bounded classification context onto the 16-route vocabulary and returns a
// target + confidence. This module is deliberately independent of
// routing/rules.ts — it never evaluates the deterministic rules.
//
// Transport (needle2:runtime-recipe): the native engine (`needle --tools
// tools.json --serve`) exposes POST http://localhost:8080/complete. Request
// body carries the bounded context plus the 16-route tool schema (the task
// requires the vocabulary to travel with the request; servers started with a
// generic `--tools` set ignore the extra field). Response:
//   { type: "call", success: true, function_calls: [{ name, arguments }],
//     reasoning, confidence }
// `arguments` (target + confidence) are grammar-constrained per the declared
// schema; `confidence` also appears top-level as a fallback.
//
// Failure policy (spec §35, §92): server down / timeout / invalid JSON /
// invalid schema / unknown route / low confidence → `{ route: "direct" }`
// with `confidence: <response confidence or 0>` and reasonCodes starting
// with "needle-fallback". The router NEVER fails and NEVER widens R beyond
// the ToolRouter contract (`Effect.Effect<RouteDecision, never, never>`).

// --- Protocol types (spec §12-13) ------------------------------------------

// The 16-route vocabulary the classifier chooses from (§13).
export const NEEDLE_ROUTES = [
  "DIRECT_READ",
  "DIRECT_SEARCH",
  "DIRECT_GLOB",
  "SYMBOL_SEARCH",
  "REFERENCES",
  "CALLERS",
  "CALLEES",
  "DEPENDENTS",
  "IMPORTS",
  "IMPLEMENTATIONS",
  "EXTENSIONS",
  "IMPACT",
  "STRUCTURAL",
  "ARCHITECTURE",
  "OWNERSHIP",
  "HYBRID",
] as const

export type NeedleRoute = (typeof NEEDLE_ROUTES)[number]

// Tool schema describing the route vocabulary + the output fields the
// classifier must fill (`target` string, `confidence` number 0..1).
export interface NeedleToolSchema {
  readonly name: NeedleRoute
  readonly description: string
  readonly parameters: {
    readonly type: "object"
    readonly properties: {
      readonly target: { readonly type: "string" }
      readonly confidence: { readonly type: "number"; readonly minimum: 0; readonly maximum: 1 }
    }
    readonly required: readonly ["target", "confidence"]
  }
}

// Bounded classification context (spec §15-17, §69-70): the current tool call,
// a truncated user request, recent tool NAMES ONLY (never their arguments or
// results), and cheap repository metadata. No file contents, no history —
// repository text is untrusted routing input (prompt injection).
export interface NeedleRequestContext {
  readonly toolCall: { readonly name: string; readonly arguments: Record<string, unknown> }
  readonly userRequest?: string
  readonly recentToolNames: readonly string[]
  readonly repositoryRoot?: string
  readonly graphStatus?: "fresh" | "stale" | "building" | "unavailable"
}

export interface NeedleRequest {
  readonly context: NeedleRequestContext
  readonly tools: readonly NeedleToolSchema[]
}

// Typed client response. `ok: false` carries a stable machine-readable error
// code the router maps to a fallback decision; `complete` never fails on the
// Effect error channel (spec §35 — the failure is data, not control flow).
export type NeedleResponse =
  | { readonly ok: true; readonly route: NeedleRoute; readonly target?: string; readonly confidence: number }
  | { readonly ok: false; readonly error: string }

// --- Identity + policy constants (spec §43) ---------------------------------

export const NEEDLE_IDENTITY = "needle"
export const NEEDLE_VERSION = "0.1.0"

// Confidence banding (spec §24): >= 0.90 high-confidence semantic route,
// 0.70-0.90 hybrid/validation-heavy, < 0.70 prefer direct. The band thresholds
// are placeholders pending calibration; today the router only honors the
// < 0.70 direct floor and maps HYBRID to direct (below).
export const LOW_CONFIDENCE_THRESHOLD = 0.7

// Context budget (spec §17, §92): keep the wire payload small so routing
// latency is predictable and the 256-token router window is respected.
export const MAX_USER_REQUEST = 160
export const MAX_RECENT_TOOLS = 5
export const MAX_ARG_LENGTH = 120
export const MAX_ARG_ITEMS = 8

// --- Needle client constants ------------------------------------------------

export const DEFAULT_BASE_URL = "http://127.0.0.1:8080"
const REQUEST_TIMEOUT = "1 second" as const
const NEEDLE_UNAVAILABLE: NeedleResponse = { ok: false, error: "needle-unavailable" }

// --- 16-route schema (spec §13) ---------------------------------------------

const ROUTE_DESCRIPTIONS: Record<NeedleRoute, string> = {
  DIRECT_READ: "Read exact file content from the filesystem (target = file path)",
  DIRECT_SEARCH: "Literal text search over the filesystem (target = search pattern)",
  DIRECT_GLOB: "File discovery by glob pattern (target = glob pattern)",
  SYMBOL_SEARCH: "Find symbol definitions in the code graph (target = symbol name)",
  REFERENCES: "Find all references to a symbol (target = symbol name)",
  CALLERS: "Find the functions that call a symbol (target = symbol name)",
  CALLEES: "Find the functions a symbol calls (target = symbol name)",
  DEPENDENTS: "Find everything that depends on a symbol (target = symbol name)",
  IMPORTS: "Find what imports a module or symbol (target = module or symbol)",
  IMPLEMENTATIONS: "Find implementations of an interface or abstract type (target = type name)",
  EXTENSIONS: "Find subclasses or extending types (target = base type name)",
  IMPACT: "Estimate the blast radius of changing a symbol (target = symbol name)",
  STRUCTURAL: "Structural query over the parsed AST (target = query text)",
  ARCHITECTURE: "Repository architecture and subsystem relationships (target = query text)",
  OWNERSHIP: "Who owns a file or subsystem (target = path or subsystem)",
  HYBRID: "Multiple mechanisms, graph plus text index (target = symbol or pattern)",
}

const toolSchemaFor = (route: NeedleRoute): NeedleToolSchema => ({
  name: route,
  description: ROUTE_DESCRIPTIONS[route],
  parameters: {
    type: "object",
    properties: {
      target: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["target", "confidence"],
  },
})

export const NEEDLE_TOOLS: readonly NeedleToolSchema[] = NEEDLE_ROUTES.map(toolSchemaFor)

// --- Bounded context builder (spec §15-17, §69-70) --------------------------

// Truncate to at most `max` characters, appending an ellipsis marker when cut.
const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

// Bound every argument value: strings truncated, arrays/objects limited to
// MAX_ARG_ITEMS entries. Prevents an oversized tool argument (e.g. an edit
// payload) from inflating the prompt or smuggling repository text into the
// classifier.
const boundedArgument = (value: unknown): unknown => {
  if (typeof value === "string") return truncate(value, MAX_ARG_LENGTH)
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value
  if (Array.isArray(value)) return value.slice(0, MAX_ARG_ITEMS).map(boundedArgument)
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (Object.keys(out).length >= MAX_ARG_ITEMS) break
      out[key] = boundedArgument(item)
    }
    return out
  }
  return truncate(String(value), MAX_ARG_LENGTH)
}

const boundedArguments = (args: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (Object.keys(out).length >= MAX_ARG_ITEMS) break
    out[key] = boundedArgument(value)
  }
  return out
}

// Only tool NAMES from history — never arguments or results (§15, §22).
const buildContext = (input: RouterInput): NeedleRequestContext => ({
  toolCall: {
    name: input.toolName,
    arguments: boundedArguments(input.arguments),
  },
  ...(input.userRequest !== undefined && input.userRequest.trim() !== ""
    ? { userRequest: truncate(input.userRequest, MAX_USER_REQUEST) }
    : {}),
  recentToolNames: input.recentToolCalls.slice(0, MAX_RECENT_TOOLS).map((call) => call.tool),
  ...(input.repositoryContext?.root !== undefined ? { repositoryRoot: input.repositoryContext.root } : {}),
  ...(input.repositoryContext?.graphStatus !== undefined ? { graphStatus: input.repositoryContext.graphStatus } : {}),
})

export const buildRequest = (input: RouterInput): NeedleRequest => ({
  context: buildContext(input),
  tools: NEEDLE_TOOLS,
})

// Prompt renderer (spec §15-16 ordering: current tool call first so the action
// stays dominant, then user task, recent actions, repository metadata).
const serializeArguments = (args: Record<string, unknown>): string => {
  const entries = Object.entries(args)
  if (entries.length === 0) return ""
  const text = entries
    .slice(0, MAX_ARG_ITEMS)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ")
  return truncate(text, MAX_ARG_LENGTH * 2)
}

export const buildInput = (request: NeedleRequest): string => {
  const ctx = request.context
  const lines: string[] = [
    "You are a repository-routing classifier. Classify the current model tool call into exactly one route from the provided tools, filling target (string) and confidence (number 0..1).",
  ]
  lines.push("", "CURRENT MODEL TOOL CALL:", `${ctx.toolCall.name}(${serializeArguments(ctx.toolCall.arguments)})`)
  if (ctx.userRequest !== undefined && ctx.userRequest.trim() !== "") {
    lines.push("", "USER TASK:", ctx.userRequest)
  }
  if (ctx.recentToolNames.length > 0) {
    lines.push("", "RECENT REPOSITORY ACTIONS:", ctx.recentToolNames.join(", "))
  }
  const repo: string[] = []
  if (ctx.repositoryRoot !== undefined) repo.push(`root: ${ctx.repositoryRoot}`)
  if (ctx.graphStatus !== undefined) repo.push(`graph: ${ctx.graphStatus}`)
  if (repo.length > 0) lines.push("", "REPOSITORY:", ...repo)
  return lines.join("\n")
}

// --- Response parsing (client boundary) -------------------------------------

// Shape validation only — the ROUTER validates the route label against the
// vocabulary so an unknown label surfaces as a distinguishable fallback.
// Never throws.
export const parseResponse = (body: string): NeedleResponse => {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return { ok: false, error: "needle-invalid-json" }
  }
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "needle-invalid-schema" }
  const record = raw as Record<string, unknown>
  if (record.success === false) return { ok: false, error: "needle-error" }
  if (record.type !== "call") return { ok: false, error: "needle-no-tool-call" }
  if (!Array.isArray(record.function_calls) || record.function_calls.length === 0) {
    return { ok: false, error: "needle-no-tool-call" }
  }
  const call = record.function_calls[0]
  if (typeof call !== "object" || call === null || typeof (call as Record<string, unknown>).name !== "string") {
    return { ok: false, error: "needle-invalid-schema" }
  }
  const callRecord = call as Record<string, unknown>
  const args = typeof callRecord.arguments === "object" && callRecord.arguments !== null
    ? (callRecord.arguments as Record<string, unknown>)
    : {}
  const target = typeof args.target === "string" ? args.target : undefined
  const confidence =
    typeof args.confidence === "number" && Number.isFinite(args.confidence)
      ? args.confidence
      : typeof record.confidence === "number" && Number.isFinite(record.confidence)
        ? record.confidence
        : undefined
  if (confidence === undefined || confidence < 0 || confidence > 1) {
    return { ok: false, error: "needle-invalid-schema" }
  }
  return { ok: true, route: callRecord.name as NeedleRoute, ...(target !== undefined ? { target } : {}), confidence }
}

// --- NeedleClient service ---------------------------------------------------

// `@banyancode/NeedleClient` — thin, never-failing HTTP client for the needle
// server. Plain `fetch` (localhost, no auth): simpler than wiring
// FetchHttpClient into the default layer chain, and the mock seam in tests
// (Layer.mock) never touches the network.
export interface Interface {
  readonly complete: (input: NeedleRequest) => Effect.Effect<NeedleResponse, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/NeedleClient") {}

export interface NeedleClientOptions {
  readonly baseUrl?: string
}

const completeWith =
  (baseUrl: string): Interface["complete"] =>
  (request) =>
    Effect.gen(function* () {
      const text = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(`${baseUrl}/complete`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: buildInput(request), tools: request.tools }),
          })
          if (!response.ok) throw new Error(`needle server responded with status ${response.status}`)
          return await response.text()
        },
        catch: (error) =>
          new Error(`needle request failed: ${error instanceof Error ? error.message : String(error)}`),
      }).pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.catchCause(() => Effect.succeed("")),
      )
      if (text === "") return NEEDLE_UNAVAILABLE
      return parseResponse(text)
    })

export const make = (options: NeedleClientOptions = {}): Interface => ({
  complete: completeWith(options.baseUrl ?? DEFAULT_BASE_URL),
})

export const layer = (options: NeedleClientOptions = {}): Layer.Layer<Service, never, never> =>
  Layer.succeed(Service, make(options))

export const defaultLayer: Layer.Layer<Service, never, never> = layer({})

// --- Decision mapping -------------------------------------------------------

// §13 semantic route -> RepositoryOperation relation. `Relation` has no
// "impact" member; IMPACT (blast radius) is transitive dependents, matching
// the deterministic router's impact -> dependents mapping (router.ts:43).
const RELATION_BY_ROUTE: Readonly<Record<string, Relation>> = {
  CALLERS: "callers",
  CALLEES: "callees",
  REFERENCES: "references",
  DEPENDENTS: "dependents",
  IMPORTS: "imports",
  IMPLEMENTATIONS: "implementations",
  EXTENSIONS: "extensions",
  IMPACT: "dependents",
}

const patternFromArguments = (input: RouterInput): string | undefined => {
  for (const key of ["pattern", "query", "target"] as const) {
    const value = input.arguments[key]
    if (typeof value === "string" && value.trim() !== "") return value
  }
  return undefined
}

const confidenceCode = (confidence: number): string => `confidence:${confidence}`

// Fail-closed direct decision (spec §35). `confidence` is the response
// confidence when one was produced, otherwise 0.
const fallback = (confidence: number, reasons: readonly string[]): RouteDecision => ({
  route: "direct",
  confidence,
  reasonCodes: reasons,
  router: NEEDLE_IDENTITY,
  routerVersion: NEEDLE_VERSION,
})

// Pure response -> RouteDecision mapping. Never throws: every path resolves to
// a decision (semantic route or fail-closed direct).
export const toDecision = (response: NeedleResponse, input: RouterInput): RouteDecision => {
  if (!response.ok) return fallback(0, ["needle-fallback", response.error])
  const { route, confidence } = response
  const codes: readonly string[] = ["needle", confidenceCode(confidence)]

  // spec §24: < 0.70 prefers direct behavior regardless of the semantic route.
  if (confidence < LOW_CONFIDENCE_THRESHOLD) {
    return fallback(confidence, ["needle-fallback", "needle-low-confidence"])
  }

  if (route === "DIRECT_READ" || route === "DIRECT_SEARCH" || route === "DIRECT_GLOB") {
    return {
      route: "direct",
      confidence,
      reasonCodes: codes,
      router: NEEDLE_IDENTITY,
      routerVersion: NEEDLE_VERSION,
    }
  }

  // HYBRID -> direct fail-safe, mirroring RulesRouter's hybrid-direct-failsafe
  // (router.ts:120-127): both the graph and the text index are plausible and a
  // misroute costs more than a miss (spec §46 — optimize false-intelligence
  // rate first). A learned classifier can arbitrate the 0.70-0.90 band later.
  if (route === "HYBRID") {
    return fallback(confidence, ["needle-fallback", "needle-hybrid-failsafe"])
  }

  const target = response.target?.trim() ?? patternFromArguments(input) ?? ""
  const operation = ((): RepositoryOperation | undefined => {
    if (route === "SYMBOL_SEARCH") return { kind: "symbol", query: target }
    const relation = RELATION_BY_ROUTE[route]
    if (relation !== undefined) return { kind: "relationship", relation, target }
    if (route === "STRUCTURAL") return { kind: "structural", query: target }
    if (route === "ARCHITECTURE") return { kind: "architecture", query: target }
    if (route === "OWNERSHIP") return { kind: "ownership", query: target }
    // Unknown route label (spec §35): not part of the 16-route vocabulary.
    return undefined
  })()

  if (operation === undefined) {
    return fallback(confidence, ["needle-fallback", "needle-unknown-route"])
  }
  // A semantic route with no extractable target is not actionable — fail
  // closed to the original tool semantics rather than fabricate a query.
  if (target === "") {
    return fallback(confidence, ["needle-fallback", "needle-missing-target"])
  }
  return {
    route: "intelligence",
    operation,
    confidence,
    reasonCodes: codes,
    router: NEEDLE_IDENTITY,
    routerVersion: NEEDLE_VERSION,
  }
}

// --- Router -----------------------------------------------------------------

const classifyWith = (client: Interface, input: RouterInput): Effect.Effect<RouteDecision, never, never> =>
  Effect.gen(function* () {
    // Transport/parse failures are already data (ok: false) inside the client;
    // the router still guards the boundary with timeout + catchCause so a
    // defective client (e.g. a mocked or broken implementation) can never fail
    // classification (spec §35).
    const response = yield* client.complete(buildRequest(input)).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.catchCause(() => Effect.succeed(NEEDLE_UNAVAILABLE)),
    )
    return toDecision(response, input)
  })

// The learned-classifier router. Consumes `@banyancode/NeedleClient` from the
// context via serviceOption (R stays never); when the client is missing the
// router falls back to direct — the byte-identical default path.
export const NeedleRouter: ToolRouter = {
  classify: (input: RouterInput): Effect.Effect<RouteDecision, never, never> =>
    Effect.gen(function* () {
      const clientOpt = yield* Effect.serviceOption(Service)
      if (Option.isNone(clientOpt)) return fallback(0, ["needle-fallback", "needle-client-missing"])
      return yield* classifyWith(clientOpt.value, input)
    }),
}

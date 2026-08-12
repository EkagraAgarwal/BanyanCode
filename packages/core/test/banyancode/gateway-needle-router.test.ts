import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Service as BanyanConfigService } from "../../src/banyancode/banyan-config"
import { RepositoryGateway } from "../../src/banyancode/gateway"
import {
  MAX_RECENT_TOOLS,
  MAX_USER_REQUEST,
  NEEDLE_IDENTITY,
  NEEDLE_ROUTES,
  NEEDLE_VERSION,
  NeedleRouter,
  Service as NeedleClientService,
  buildInput,
  buildRequest,
  parseResponse,
  toDecision,
  type NeedleRequest,
  type NeedleResponse,
} from "../../src/banyancode/gateway/needle-router"
import { testEffect } from "../lib/effect"
import type { RouterInput } from "../../src/banyancode/gateway/types"

process.env.BANYANCODE_ENABLE = "1"

const it = testEffect(Layer.empty)

type OkResponse = Extract<NeedleResponse, { readonly ok: true }>

// RouterInput shorthand for grep-style calls.
const grep = (pattern: string, extra: Record<string, unknown> = {}, userRequest?: string) => ({
  toolName: "grep",
  arguments: { pattern, ...extra },
  recentToolCalls: [],
  ...(userRequest !== undefined ? { userRequest } : {}),
})

// Mock client layer. The `complete` closure is the server double; capture
// arrays inside it let tests inspect the exact request the router sent.
const mockClient = (complete: (input: NeedleRequest) => Effect.Effect<NeedleResponse, never, never>) =>
  Layer.mock(NeedleClientService, { complete })

const ok = (route: string, confidence: number, target?: string): OkResponse => ({
  ok: true,
  route: route as OkResponse["route"],
  confidence,
  ...(target !== undefined ? { target } : {}),
})

const classifyWith = (input: RouterInput, complete: (input: NeedleRequest) => Effect.Effect<NeedleResponse, never, never>) =>
  NeedleRouter.classify(input).pipe(Effect.provide(mockClient(complete)))

describe("NeedleRouter (Phase 4 — learned classifier)", () => {
  describe("route mapping (spec §13)", () => {
    it.effect("CALLERS -> intelligence relationship:callers with the response target", () =>
      Effect.gen(function* () {
        const decision = yield* classifyWith(
          grep("AuthManager", {}, "who calls AuthManager?"),
          () => Effect.succeed(ok("CALLERS", 0.97, "AuthManager")),
        )
        expect(decision.route).toBe("intelligence")
        expect(decision.operation).toEqual({ kind: "relationship", relation: "callers", target: "AuthManager" })
        expect(decision.confidence).toBe(0.97)
        expect(decision.reasonCodes).toContain("needle")
        expect(decision.reasonCodes).toContain("confidence:0.97")
        expect(decision.router).toBe(NEEDLE_IDENTITY)
        expect(decision.routerVersion).toBe(NEEDLE_VERSION)
      }),
    )

    it.effect("DIRECT_READ -> direct", () =>
      Effect.gen(function* () {
        const decision = yield* classifyWith(
          { toolName: "read", arguments: { path: "README.md" }, recentToolCalls: [] },
          () => Effect.succeed(ok("DIRECT_READ", 0.99, "README.md")),
        )
        expect(decision.route).toBe("direct")
        expect(decision.confidence).toBe(0.99)
        expect(decision.reasonCodes).toEqual(["needle", "confidence:0.99"])
      }),
    )

    it.effect("DIRECT_SEARCH -> direct", () =>
      Effect.gen(function* () {
        const decision = yield* classifyWith(
          grep("TODO", { path: "docs/" }),
          () => Effect.succeed(ok("DIRECT_SEARCH", 0.95)),
        )
        expect(decision.route).toBe("direct")
      }),
    )

    it.effect("SYMBOL_SEARCH -> symbol op", () =>
      Effect.gen(function* () {
        const decision = yield* classifyWith(grep("AuthManager"), () =>
          Effect.succeed(ok("SYMBOL_SEARCH", 0.93, "AuthManager")),
        )
        expect(decision.route).toBe("intelligence")
        expect(decision.operation).toEqual({ kind: "symbol", query: "AuthManager" })
      }),
    )

    it.effect("CALLEES -> relationship:callees", () =>
      Effect.gen(function* () {
        const decision = yield* classifyWith(grep("AuthManager"), () =>
          Effect.succeed(ok("CALLEES", 0.91, "AuthManager")),
        )
        expect(decision.operation).toEqual({ kind: "relationship", relation: "callees", target: "AuthManager" })
      }),
    )

    it.effect("IMPACT -> relationship:dependents (transitive dependents, spec §13 mapping)", () =>
      Effect.gen(function* () {
        const decision = yield* classifyWith(grep("AuthManager"), () =>
          Effect.succeed(ok("IMPACT", 0.92, "AuthManager")),
        )
        expect(decision.route).toBe("intelligence")
        expect(decision.operation).toEqual({ kind: "relationship", relation: "dependents", target: "AuthManager" })
      }),
    )

    it.effect("STRUCTURAL -> structural op", () =>
      Effect.gen(function* () {
        const decision = yield* classifyWith(grep("classes extending BaseController"), () =>
          Effect.succeed(ok("STRUCTURAL", 0.9, "classes extending BaseController")),
        )
        expect(decision.route).toBe("intelligence")
        expect(decision.operation).toEqual({ kind: "structural", query: "classes extending BaseController" })
      }),
    )

    it.effect("ARCHITECTURE -> architecture op", () =>
      Effect.gen(function* () {
        const decision = yield* classifyWith(grep("auth subsystem"), () =>
          Effect.succeed(ok("ARCHITECTURE", 0.9, "auth subsystem")),
        )
        expect(decision.operation).toEqual({ kind: "architecture", query: "auth subsystem" })
      }),
    )

    it.effect("OWNERSHIP -> ownership op", () =>
      Effect.gen(function* () {
        const decision = yield* classifyWith(grep("who owns auth"), () =>
          Effect.succeed(ok("OWNERSHIP", 0.9, "auth")),
        )
        expect(decision.operation).toEqual({ kind: "ownership", query: "auth" })
      }),
    )

    it.effect("relation route without a response target falls back to the pattern argument", () =>
      Effect.gen(function* () {
        const decision = yield* classifyWith(grep("AuthManager"), () => Effect.succeed(ok("CALLERS", 0.9)))
        expect(decision.route).toBe("intelligence")
        expect(decision.operation).toEqual({ kind: "relationship", relation: "callers", target: "AuthManager" })
      }),
    )
  })

  describe("fail-closed fallbacks (spec §24, §35)", () => {
    it.effect("low confidence (<0.70) -> direct with needle-low-confidence", () =>
      Effect.gen(function* () {
        const decision = yield* classifyWith(
          grep("AuthManager", {}, "who calls AuthManager?"),
          () => Effect.succeed(ok("CALLERS", 0.5, "AuthManager")),
        )
        expect(decision.route).toBe("direct")
        expect(decision.confidence).toBe(0.5)
        expect(decision.reasonCodes).toEqual(["needle-fallback", "needle-low-confidence"])
      }),
    )

    it.effect("unknown route label -> direct with needle-unknown-route", () =>
      Effect.gen(function* () {
        const decision = yield* classifyWith(grep("Foo"), () =>
          Effect.succeed(ok("NOT_A_ROUTE", 0.95, "Foo")),
        )
        expect(decision.route).toBe("direct")
        expect(decision.reasonCodes).toEqual(["needle-fallback", "needle-unknown-route"])
      }),
    )

    it.effect("HYBRID -> direct (hybrid-direct failsafe, mirrors RulesRouter)", () =>
      Effect.gen(function* () {
        const decision = yield* classifyWith(grep("Foo", { path: "src" }), () =>
          Effect.succeed(ok("HYBRID", 0.8, "Foo")),
        )
        expect(decision.route).toBe("direct")
        expect(decision.reasonCodes).toEqual(["needle-fallback", "needle-hybrid-failsafe"])
      }),
    )

    it.effect("failure response (ok:false) -> direct and NEVER throws", () =>
      Effect.gen(function* () {
        const decision = yield* classifyWith(grep("Foo"), () =>
          Effect.succeed({ ok: false, error: "needle-invalid-json" }),
        )
        expect(decision.route).toBe("direct")
        expect(decision.confidence).toBe(0)
        expect(decision.reasonCodes).toEqual(["needle-fallback", "needle-invalid-json"])
        expect(decision.router).toBe(NEEDLE_IDENTITY)
      }),
    )

    it.effect("server down (mock complete dies with a typed error) -> direct via catchCause", () =>
      Effect.gen(function* () {
        const decision = yield* classifyWith(grep("Foo"), () => Effect.die(new Error("connection refused")))
        expect(decision.route).toBe("direct")
        expect(decision.reasonCodes).toEqual(["needle-fallback", "needle-unavailable"])
      }),
    )

    it.effect("no NeedleClient in context -> direct with needle-client-missing", () =>
      Effect.gen(function* () {
        const decision = yield* NeedleRouter.classify(grep("Foo"))
        expect(decision.route).toBe("direct")
        expect(decision.confidence).toBe(0)
        expect(decision.reasonCodes).toEqual(["needle-fallback", "needle-client-missing"])
      }),
    )

    it.effect("semantic route with no extractable target -> direct (never fabricates a query)", () =>
      Effect.gen(function* () {
        const decision = yield* classifyWith({ toolName: "grep", arguments: {}, recentToolCalls: [] }, () =>
          Effect.succeed(ok("CALLERS", 0.9)),
        )
        expect(decision.route).toBe("direct")
        expect(decision.reasonCodes).toEqual(["needle-fallback", "needle-missing-target"])
      }),
    )
  })

  describe("context budget (spec §15-17, §69-70)", () => {
    it.effect("sends only bounded context — no file contents, names only, capped recent tools", () =>
      Effect.gen(function* () {
        const captured: NeedleRequest[] = []
        const layer = mockClient((input) => {
          captured.push(input)
          return Effect.succeed(ok("DIRECT_SEARCH", 0.95))
        })
        const marker = "function leakedSecret() { return 'do-not-send-this-marker' }"
        const filePath = "src/secret.ts"
        const recent = Array.from({ length: 8 }, (_, i) => ({
          tool: `tool${i}`,
          arguments: { path: filePath, content: marker },
        }))
        yield* NeedleRouter.classify({
          toolName: "grep",
          arguments: { pattern: "AuthManager", path: "src" },
          userRequest: "x".repeat(2000),
          recentToolCalls: recent,
          repositoryContext: {
            root: "D:/repo",
            graphStatus: "fresh",
            supportedLanguages: ["typescript"],
          },
        }).pipe(Effect.provide(layer))

        const sent = captured[0]
        expect(sent).toBeDefined()
        // History contributes NAMES ONLY, capped at MAX_RECENT_TOOLS, in order.
        expect(sent.context.recentToolNames.length).toBeLessThanOrEqual(MAX_RECENT_TOOLS)
        expect(sent.context.recentToolNames).toEqual(["tool0", "tool1", "tool2", "tool3", "tool4"])
        // userRequest truncated to the budget.
        expect(sent.context.userRequest?.length ?? 0).toBeLessThanOrEqual(MAX_USER_REQUEST)
        // Cheap repository metadata is included.
        expect(sent.context.repositoryRoot).toBe("D:/repo")
        expect(sent.context.graphStatus).toBe("fresh")
        // NO file contents, NO history arguments, NO history paths anywhere.
        const serialized = JSON.stringify(sent)
        expect(serialized).not.toContain("do-not-send-this-marker")
        expect(serialized).not.toContain(filePath)
        // The 16-route vocabulary travels with the request (§13).
        expect(sent.tools.map((t) => t.name)).toEqual([...NEEDLE_ROUTES])
        expect(sent.tools.length).toBe(16)
      }),
    )

    it.effect("buildInput renders the §15 ordering and stays compact", () =>
      Effect.gen(function* () {
        const request = buildRequest(grep("AuthManager", {}, "who calls AuthManager?"))
        const prompt = buildInput(request)
        expect(prompt).toContain("CURRENT MODEL TOOL CALL:")
        expect(prompt).toContain('grep(pattern="AuthManager")')
        expect(prompt).toContain("USER TASK:")
        expect(prompt).toContain("who calls AuthManager?")
        expect(prompt.length).toBeLessThan(1200)
      }),
    )
  })

  describe("toDecision (pure mapping)", () => {
    it.effect("maps ok responses without an input dependency for direct routes", () =>
      Effect.gen(function* () {
        const decision = toDecision(ok("DIRECT_GLOB", 0.94), grep("**/*.ts"))
        expect(decision.route).toBe("direct")
        expect(decision.confidence).toBe(0.94)
      }),
    )
  })

  describe("parseResponse (client boundary)", () => {
    test("invalid JSON -> ok:false needle-invalid-json", () => {
      const parsed = parseResponse("{not json")
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).toBe("needle-invalid-json")
    })

    test("success:false -> ok:false needle-error", () => {
      const parsed = parseResponse(JSON.stringify({ success: false, error: "boom" }))
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).toBe("needle-error")
    })

    test("type respond / empty function_calls -> ok:false needle-no-tool-call", () => {
      const refused = parseResponse(JSON.stringify({ type: "respond", success: true, function_calls: [], confidence: 0.9 }))
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.error).toBe("needle-no-tool-call")
    })

    test("valid call -> route/target/confidence extracted (arguments preferred over top-level)", () => {
      const body = JSON.stringify({
        type: "call",
        success: true,
        function_calls: [{ name: "CALLERS", arguments: { target: "AuthManager", confidence: 0.97 } }],
        reasoning: "relationship language",
        confidence: 0.6,
      })
      const parsed = parseResponse(body)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.route).toBe("CALLERS")
        expect(parsed.target).toBe("AuthManager")
        expect(parsed.confidence).toBe(0.97)
      }
    })

    test("confidence outside [0,1] -> ok:false needle-invalid-schema", () => {
      const parsed = parseResponse(
        JSON.stringify({ type: "call", success: true, function_calls: [{ name: "CALLERS", arguments: { target: "X", confidence: 1.5 } }] }),
      )
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).toBe("needle-invalid-schema")
    })
  })
})

describe("gateway selection (BANYANCODE_ROUTER=needle / config needle)", () => {
  const restoreEnv = (value: string | undefined) => {
    if (value === undefined) delete process.env.BANYANCODE_ROUTER
    else process.env.BANYANCODE_ROUTER = value
  }

  it.effect("env needle wires NeedleRouter — the mock client is consulted and the outcome is direct", () =>
    Effect.gen(function* () {
      const prev = process.env.BANYANCODE_ROUTER
      process.env.BANYANCODE_ROUTER = "needle"
      try {
        let calls = 0
        const layer = Layer.provideMerge(
          RepositoryGateway.defaultLayer,
          mockClient(() => {
            calls++
            return Effect.succeed(ok("DIRECT_SEARCH", 0.95))
          }),
        )
        const outcome = yield* Effect.gen(function* () {
          const gateway = yield* RepositoryGateway.Service
          return yield* gateway.execute({
            source: "model-tool",
            originalTool: "grep",
            arguments: { pattern: "AuthManager" },
          })
        }).pipe(Effect.provide(layer))
        expect(outcome.route).toBe("direct")
        // The client was consulted: NoopRouter/RulesRouter would never call it.
        expect(calls).toBe(1)
      } finally {
        restoreEnv(prev)
      }
    }),
  )

  it.effect("config banyancode_router=needle wires NeedleRouter", () =>
    Effect.gen(function* () {
      const prev = process.env.BANYANCODE_ROUTER
      restoreEnv(undefined)
      try {
        let calls = 0
        const layer = Layer.provideMerge(
          RepositoryGateway.defaultLayer,
          Layer.mergeAll(
            Layer.mock(BanyanConfigService, {
              get: () => Effect.succeed({ banyancode_router: "needle" }),
              getGlobal: () => Effect.succeed({}),
              update: () => Effect.succeed({}),
              updateAgentOverride: () => Effect.succeed({}),
              getAgentOverrides: () => Effect.succeed({}),
              updateAgentPrompt: () => Effect.succeed({}),
            }),
            mockClient(() => {
              calls++
              return Effect.succeed(ok("CALLERS", 0.97, "AuthManager"))
            }),
          ),
        )
        const outcome = yield* Effect.gen(function* () {
          const gateway = yield* RepositoryGateway.Service
          return yield* gateway.execute({
            source: "model-tool",
            originalTool: "grep",
            arguments: { pattern: "who calls AuthManager" },
          })
        }).pipe(Effect.provide(layer))
        // CALLERS decision selects the intelligence backend, but with no
        // RepositoryIntelligence service the backend fails closed -> direct.
        expect(outcome.route).toBe("direct")
        expect(calls).toBe(1)
      } finally {
        restoreEnv(prev)
      }
    }),
  )
})

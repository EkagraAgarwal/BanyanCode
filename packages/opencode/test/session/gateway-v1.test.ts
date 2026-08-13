import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { GatewayV1 } from "../../src/session/gateway-v1"

// Fixtures are behavior-focused: deriveGateB only reads `info.role` and
// `parts`, so minimal messages are built with a boundary cast.
const userMessage = (text: string, id = "u1"): SessionV1.WithParts =>
  ({
    info: { role: "user", id, sessionID: "s1", time: { created: 0 }, agent: "build", model: { providerID: "p", modelID: "m" } },
    parts: [{ type: "text", id: `${id}p`, sessionID: "s1", text }],
  }) as unknown as SessionV1.WithParts

const toolPart = (tool: string, input: Record<string, unknown> | undefined, status = "completed") => ({
  type: "tool" as const,
  id: `${tool}-${Math.random()}`,
  sessionID: "s1",
  callID: `c-${tool}`,
  tool,
  state:
    status === "completed"
      ? { status: "completed" as const, input, output: "", title: "", metadata: {}, time: { start: 0, end: 1 } }
      : status === "pending"
        ? { status: "pending" as const }
        : { status: "running" as const, input: input ?? {}, title: "", metadata: {}, time: { start: 0 } },
})

const assistantMessage = (parts: ReturnType<typeof toolPart>[], id = "a1"): SessionV1.WithParts =>
  ({
    info: {
      role: "assistant",
      id,
      sessionID: "s1",
      time: { created: 0 },
      parentID: "u1",
      modelID: "m",
      providerID: "p",
      mode: "default",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { input: 0, output: 0, reasoning: 0 } },
    },
    parts,
  }) as unknown as SessionV1.WithParts

describe("GatewayV1.deriveGateB", () => {
  test("empty messages yield empty context", () => {
    const gateB = GatewayV1.deriveGateB([])
    expect(gateB.userRequest).toBeUndefined()
    expect(gateB.recentToolCalls).toEqual([])
  })

  test("takes the last user message's text content truncated to 200 chars", () => {
    const long = "a".repeat(300)
    const gateB = GatewayV1.deriveGateB([userMessage("first", "u1"), userMessage(long, "u2")])
    expect(gateB.userRequest).toBe("a".repeat(200))
  })

  test("no user message yields undefined userRequest", () => {
    const gateB = GatewayV1.deriveGateB([assistantMessage([toolPart("read", { path: "a.ts" })])])
    expect(gateB.userRequest).toBeUndefined()
    expect(gateB.recentToolCalls).toEqual([{ tool: "read", arguments: { path: "a.ts" } }])
  })

  test("collects the last 5 assistant tool parts as { tool, arguments }", () => {
    const parts = [1, 2, 3, 4, 5, 6, 7].map((n) => toolPart(`tool${n}`, { n }))
    const gateB = GatewayV1.deriveGateB([userMessage("hi"), assistantMessage(parts)])
    expect(gateB.recentToolCalls).toHaveLength(5)
    expect(gateB.recentToolCalls[0]).toEqual({ tool: "tool3", arguments: { n: 3 } })
    expect(gateB.recentToolCalls[4]).toEqual({ tool: "tool7", arguments: { n: 7 } })
  })

  test("pending/error tool parts yield empty arguments", () => {
    const gateB = GatewayV1.deriveGateB([
      assistantMessage([toolPart("read", undefined, "pending"), toolPart("grep", { pattern: "x" }, "running")]),
    ])
    expect(gateB.recentToolCalls).toEqual([
      { tool: "read", arguments: {} },
      { tool: "grep", arguments: { pattern: "x" } },
    ])
  })
})

describe("GatewayV1.applyOutcome", () => {
  const result = { title: "t", output: "original" }

  test("non-object outcome returns the result unchanged", () => {
    expect(GatewayV1.applyOutcome("read", undefined, result)).toEqual(result)
    expect(GatewayV1.applyOutcome("read", null, result)).toEqual(result)
    expect(GatewayV1.applyOutcome("read", "direct", result)).toEqual(result)
  })

  test("augment prepends the header only for the read tool", () => {
    const outcome = { route: "augment", header: "Symbol: Foo | Imports: 1", result: { route: "augment" } }
    expect(GatewayV1.applyOutcome("read", outcome, result)).toEqual({
      title: "t",
      output: "Symbol: Foo | Imports: 1\noriginal",
    })
    expect(GatewayV1.applyOutcome("grep", outcome, result)).toEqual(result)
  })

  test("augment without a string header passes through", () => {
    expect(GatewayV1.applyOutcome("read", { route: "augment" }, result)).toEqual(result)
    expect(GatewayV1.applyOutcome("read", { route: "augment", header: 42 }, result)).toEqual(result)
  })

  test("intelligence renders via the Formatter when the result is renderable", () => {
    const outcome = {
      route: "intelligence",
      result: {
        route: "intelligence",
        operation: { kind: "symbol", query: "MemoryRepo" },
        source: "codegraph",
        results: [{ path: "packages/core/src/banyancode/memory-repo.ts", line: 42, name: "MemoryRepo.update" }],
        provenance: { originalTool: "grep", resolvedOperation: "symbol", router: "rules", routerVersion: "1" },
        freshness: { graph: "fresh" },
      },
    }
    const applied = GatewayV1.applyOutcome("grep", outcome, result)
    expect(applied.title).toBe("t")
    expect(applied.output).toContain('Symbols for "MemoryRepo":')
    expect(applied.output).toContain("packages/core/src/banyancode/memory-repo.ts:42 (MemoryRepo.update)")
  })

  test("intelligence with a non-renderable result renders a compact summary", () => {
    const outcome = {
      route: "intelligence",
      result: {
        provenance: { resolvedOperation: "symbol" },
        freshness: { graph: "stale" },
        results: [{ name: "orphan", text: "no path here" }, { path: "a.ts", line: 7, text: "snippet" }],
      },
    }
    const applied = GatewayV1.applyOutcome("grep", outcome, result)
    expect(applied.title).toBe("t")
    expect(applied.output).toContain("route: intelligence")
    expect(applied.output).toContain("resolvedOperation: symbol")
    expect(applied.output).toContain("freshness: stale")
    expect(applied.output).toContain("a.ts:7 snippet")
    expect(applied.output).not.toContain("no path here")
  })

  test("intelligence with a primitive result passes through", () => {
    expect(GatewayV1.applyOutcome("grep", { route: "intelligence", result: "nope" }, result)).toEqual(result)
  })

  test("unknown route returns the result unchanged", () => {
    expect(GatewayV1.applyOutcome("read", { route: "direct" }, result)).toEqual(result)
  })
})

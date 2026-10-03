// Verification aggregation for task results (gap-plan Milestone C5).
//
// `aggregateVerification` (src/mcp-server/result.ts) folds verifier tool
// parts from a session transcript — `banyan_test` / `banyan_typecheck` /
// `banyan_lint` (agent-side names) plus `banyan_verify` — into the result's
// `verification` field: per-kind pass/fail/counts plus first-N failures.
// With no verifier parts the field stays absent (never fabricated).
//
// The live test at the bottom sources parts from a REAL session: the agent
// actually executes `banyan_test` twice (once failing, once passing) through
// the in-process server, and the test reads the raw tool parts back over the
// SDK, aggregates them, and asserts the compact result reports pass/fail.

import { afterEach, describe, expect, test } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import {
  aggregateVerification,
  buildCompactResult,
  isVerifierTool,
  verifierKindForTool,
} from "../../src/mcp-server/result"
import type { VerifierToolPartInput } from "../../src/mcp-server/result"
import { createMcpServer } from "../../src/mcp-server/server"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const completed = (tool: string, output: unknown): VerifierToolPartInput => ({
  tool,
  status: "completed",
  output: typeof output === "string" ? output : JSON.stringify(output),
})

describe("mcp verification aggregation", () => {
  test("tool-name gate: only verifier tools count", () => {
    expect(isVerifierTool("banyan_test")).toBe(true)
    expect(isVerifierTool("banyan_typecheck")).toBe(true)
    expect(isVerifierTool("banyan_lint")).toBe(true)
    expect(isVerifierTool("banyan_verify")).toBe(true)
    expect(isVerifierTool("bash")).toBe(false)
    expect(isVerifierTool("read")).toBe(false)
    expect(verifierKindForTool("banyan_test")).toBe("test")
    expect(verifierKindForTool("banyan_typecheck")).toBe("typecheck")
  })

  test("no verifier parts means absent, never fabricated", () => {
    expect(aggregateVerification([])).toBeUndefined()
    expect(
      aggregateVerification([
        { tool: "bash", status: "completed", output: JSON.stringify({ status: "passed" }) },
        { tool: "read", status: "completed", output: "{}" },
      ]),
    ).toBeUndefined()
    // Unsettled runs do not count either.
    expect(
      aggregateVerification([
        { tool: "banyan_test", status: "running" },
        { tool: "banyan_test", status: "pending" },
      ]),
    ).toBeUndefined()
  })

  test("a passing test run reports pass with counts", () => {
    const verification = aggregateVerification([
      completed("banyan_test", {
        status: "passed",
        summary: { passed: 3, failed: 0, skipped: 1 },
        durationMs: 40,
        cacheHit: false,
      }),
    ])
    expect(verification).toEqual({ kind: "test", passed: true, counts: "test: 3 passed, 0 failed, 1 skipped" })
  })

  test("a failing run reports fail with first-N failures", () => {
    const verification = aggregateVerification(
      [
        completed("banyan_test", {
          status: "failed",
          summary: { passed: 8, failed: 2, skipped: 0 },
          durationMs: 120,
          cacheHit: false,
          rawOutput: "ok line\nFAIL a\n\nFAIL b\nFAIL c\n",
        }),
      ],
      2,
    )
    expect(verification?.passed).toBe(false)
    expect(verification?.kind).toBe("test")
    expect(verification?.counts).toBe("test: 8 passed, 2 failed")
    expect(verification?.failures).toEqual(["ok line", "FAIL a"])
  })

  test("error-state parts count as failures with the error text", () => {
    const verification = aggregateVerification([{ tool: "banyan_lint", status: "error", error: "spawn bun ENOENT" }])
    expect(verification?.passed).toBe(false)
    expect(verification?.kind).toBe("lint")
    expect(verification?.failures).toEqual(["spawn bun ENOENT"])
  })

  test("mixed kinds join kinds and sum per-kind counts; one failure fails all", () => {
    const verification = aggregateVerification([
      completed("banyan_test", { status: "passed", summary: { passed: 3, failed: 0, skipped: 0 } }),
      completed("banyan_typecheck", { status: "failed", summary: { passed: 0, failed: 1, skipped: 0 }, rawOutput: "TS2345 boom" }),
    ])
    expect(verification?.kind).toBe("test+typecheck")
    expect(verification?.passed).toBe(false)
    expect(verification?.counts).toBe("test: 3 passed, 0 failed; typecheck: 0 passed, 1 failed")
    expect(verification?.failures).toEqual(["TS2345 boom"])
  })

  test("unparseable output falls back to the text rendering", () => {
    const verification = aggregateVerification([
      { tool: "banyan_test", status: "completed", output: "status=failed passed=1 failed=2 skipped=0\ndurationMs=5 cacheHit=false" },
    ])
    expect(verification?.passed).toBe(false)
    expect(verification?.counts).toBe("test: 1 passed, 2 failed")
    expect(verification?.failures?.length).toBeGreaterThan(0)
  })

  test("aggregated verification flows into the compact result, absent stays absent", () => {
    const verification = aggregateVerification([
      completed("banyan_test", { status: "passed", summary: { passed: 3, failed: 0, skipped: 0 } }),
    ])
    const filled = buildCompactResult({ task_id: "t", status: "done", finalMessage: "all green", verification }, {})
    expect(filled.verification?.passed).toBe(true)
    expect(filled.verification?.kind).toBe("test")
    const bare = buildCompactResult({ task_id: "t", status: "done", finalMessage: "no tests ran" }, {})
    expect(bare.verification).toBeUndefined()
  })
})

const savedCwd = process.cwd()
const savedPassword = process.env.OPENCODE_SERVER_PASSWORD

afterEach(async () => {
  process.chdir(savedCwd)
  if (savedPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = savedPassword
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, CrossSpawnSpawner.defaultLayer))

describe("mcp task verification from a real session", () => {
  it.live(
    "a task whose session ran banyan_test reports pass/fail in its result",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        // First run fails (no such file), second run passes (seeded below),
        // then the agent closes out the turn.
        yield* llm.tool("banyan_test", { path: "missing.test.ts" })
        yield* llm.tool("banyan_test", { path: "pass.test.ts" })
        yield* llm.text("tests attempted")
        const dir = yield* tmpdirScoped({
          git: true,
          config: testProviderConfig(llm.url),
          init: (directory) =>
            Effect.promise(() =>
              Bun.write(`${directory}/pass.test.ts`, `import { expect, test } from "bun:test"\ntest("ok", () => {\n  expect(1).toBe(1)\n})\n`).then(() => {}),
            ),
        })
        const boot = yield* Effect.promise(() => createMcpServer({ cwd: dir }))
        try {
          const created = yield* Effect.promise(() =>
            boot.sdk.session.create({ directory: dir, title: "[mcp] verify probe", agent: "build" }, { throwOnError: true }),
          )
          const sessionID = created.data?.id as string
          yield* Effect.promise(() =>
            boot.sdk.session.promptAsync(
              { sessionID, directory: dir, agent: "build", model: { providerID: "test", modelID: "test-model" }, parts: [{ type: "text", text: "run the tests" }] },
              { throwOnError: true },
            ),
          )

          // Settle: idle plus an assistant reply (promptAsync returns before
          // the processor flips the session to busy, and the status map
          // deletes idle entries — so a missing entry means idle).
          const deadline = Date.now() + 120_000
          for (;;) {
            if (Date.now() > deadline) throw new Error("session never settled with an assistant reply")
            const status = yield* Effect.promise(() => boot.sdk.session.status({ directory: dir }, { throwOnError: true }))
            const probe = yield* Effect.promise(() =>
              boot.sdk.session.messages({ sessionID, directory: dir }, { throwOnError: true }),
            )
            const rows = "data" in probe && Array.isArray(probe.data) ? probe.data : []
            const entry = (status as { data?: Record<string, { type?: string }> }).data?.[sessionID]
            const idle = entry === undefined || entry.type === "idle"
            const hasAssistant = rows.some((row) =>
              Array.isArray((row as { parts?: unknown }).parts) &&
              ((row as { parts: Array<{ type?: unknown; text?: unknown }> }).parts.some(
                (part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0,
              )),
            )
            if (idle && hasAssistant) break
            yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 500)))
          }

          // Source the data: raw tool parts from the real session transcript.
          // Over the SDK, part.state arrives as a JSON-encoded string, so it
          // is decoded before mapping to the aggregation input.
          const raw = yield* Effect.promise(() =>
            boot.sdk.session.messages({ sessionID, directory: dir }, { throwOnError: true }),
          )
          const rows = "data" in raw && Array.isArray(raw.data) ? raw.data : []
          const parts: VerifierToolPartInput[] = []
          for (const row of rows) {
            const messageParts = (row as { parts?: unknown }).parts
            if (!Array.isArray(messageParts)) continue
            for (const part of messageParts) {
              const candidate = part as { type?: unknown; tool?: unknown; state?: unknown }
              if (candidate.type !== "tool" || typeof candidate.tool !== "string") continue
              if (!isVerifierTool(candidate.tool)) continue
              const decoded =
                typeof candidate.state === "string"
                  ? (JSON.parse(candidate.state) as { status?: unknown; output?: unknown; error?: unknown })
                  : (candidate.state as { status?: unknown; output?: unknown; error?: unknown } | undefined)
              parts.push({
                tool: candidate.tool,
                status: typeof decoded?.status === "string" ? decoded.status : "unknown",
                ...(typeof decoded?.output === "string" ? { output: decoded.output } : {}),
                ...(typeof decoded?.error === "string" ? { error: decoded.error } : {}),
              })
            }
          }
          // Both real verifier runs are in the transcript.
          expect(parts.length).toBe(2)

          const verification = aggregateVerification(parts)
          expect(verification).toBeDefined()
          // The missing-file run failed, so the aggregate fails even though
          // the seeded run passed.
          expect(verification?.passed).toBe(false)
          expect(verification?.kind).toBe("test")
          expect(verification?.counts).toContain("test:")
          expect((verification?.failures ?? []).length).toBeGreaterThan(0)

          const compact = buildCompactResult(
            { task_id: "btask_probe", status: "done", finalMessage: "tests attempted", verification },
            {},
          )
          expect(compact.verification?.passed).toBe(false)
        } finally {
          yield* Effect.promise(() => boot.cleanup())
        }
      }),
    180_000,
  )
})

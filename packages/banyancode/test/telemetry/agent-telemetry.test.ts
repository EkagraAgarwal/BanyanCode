import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AGENT_TELEMETRY_PREFIX,
  exportAgentEvents,
  isValidAgentTelemetryKey,
  loadAgentTelemetryKey,
  localId,
  makeAgentTelemetryStore,
  sanitizeAgentEfficiencyEvent,
  summarizeAgentEvents,
  type AgentEfficiencyEvent,
} from "../../src/telemetry/agent-telemetry.js"

const withTemp = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-agent-telemetry-"))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

/** Minimal in-memory host KV with the same scan contract as the plugin API. */
const makeStorage = () => {
  const values = new Map<string, unknown>()
  const storage = {
    get: (key: string) => Effect.sync(() => values.get(key) as never),
    set: (key: string, value: unknown) =>
      Effect.sync(() => {
        values.set(key, value)
      }),
    remove: (key: string) =>
      Effect.sync(() => {
        values.delete(key)
      }),
    scan: (options: { prefix: string; after?: string; limit?: number }) =>
      Effect.sync(() => {
        const keys = [...values.keys()].filter((key) => key.startsWith(options.prefix)).sort()
        const remaining = options.after === undefined ? keys : keys.filter((key) => key > options.after!)
        const page = remaining.slice(0, options.limit ?? 100)
        const next = remaining.length > page.length ? page.at(-1) : undefined
        return {
          entries: page.map((key) => ({ key, value: values.get(key) })),
          ...(next === undefined ? {} : { next }),
        }
      }),
  }
  return { storage: storage as unknown as Context["storage"], values }
}

const event = (overrides: Partial<AgentEfficiencyEvent> = {}): AgentEfficiencyEvent => ({
  schemaVersion: 1,
  eventID: `evt-${Math.random().toString(16).slice(2)}`,
  eventType: "model.finished",
  occurredAt: 1_000,
  runID: "ses_abc",
  sessionID: "ses_abc",
  agentRole: "coder",
  metadata: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 40, uncached_input_tokens: 60, cost: 0.5 },
  ...overrides,
})

describe("agent telemetry key + local id", () => {
  test("creates a 64-hex key once and reuses it", async () => {
    await withTemp(async (directory) => {
      const file = join(directory, "nested", "agent-efficiency-telemetry.key")
      const first = loadAgentTelemetryKey(file, undefined)
      expect(isValidAgentTelemetryKey(first)).toBe(true)
      expect(loadAgentTelemetryKey(file, undefined)).toBe(first)
    })
  })

  test("BANYANCODE_AGENT_TELEMETRY_KEY wins when valid, is ignored when malformed", async () => {
    await withTemp(async (directory) => {
      const file = join(directory, "key")
      const configured = "a".repeat(64)
      expect(loadAgentTelemetryKey(file, configured)).toBe(configured)
      const generated = loadAgentTelemetryKey(file, "not-a-key")
      expect(isValidAgentTelemetryKey(generated)).toBe(true)
      expect(generated).not.toBe("not-a-key")
    })
  })

  test("local ids are stable HMACs, never the raw value", () => {
    const key = "b".repeat(64)
    const id = localId(key, "run", "D:/secret/project")
    expect(id.startsWith("run-")).toBe(true)
    expect(id).not.toContain("secret")
    expect(localId(key, "run", "D:/secret/project")).toBe(id)
  })
})

describe("agent telemetry sanitization", () => {
  test("strips sensitive metadata and redacts unsafe ids", () => {
    const key = "c".repeat(64)
    const sanitized = sanitizeAgentEfficiencyEvent(
      event({
        eventID: "not safe!",
        runID: "D:/raw/path",
        metadata: {
          input_tokens: 10,
          prompt: "secret prompt",
          tool_name: "read",
          path: "D:/secret/file.ts",
          nested: { cost: 1, arguments: "nope" },
        },
      }),
      key,
    )
    expect(sanitized.eventID.startsWith("event-")).toBe(true)
    expect(sanitized.runID.startsWith("run-")).toBe(true)
    expect(sanitized.metadata).toEqual({ input_tokens: 10, tool_name: "read", nested: { cost: 1 } })
  })
})

describe("agent telemetry store + report/export", () => {
  test("records sanitized events and filters like v1 agent-report", async () => {
    const { storage } = makeStorage()
    const store = makeAgentTelemetryStore(storage, { keyFile: "unused", configuredKey: "d".repeat(64) })
    await Effect.runPromise(store.record(event({ occurredAt: 100 })))
    await Effect.runPromise(store.record(event({ occurredAt: 200, sessionID: "ses_other", runID: "ses_other" })))
    await Effect.runPromise(store.record(event({ occurredAt: 300, eventType: "tool.finished", metadata: { tool_name: "read" } })))

    expect(await Effect.runPromise(store.count())).toBe(3)
    const filtered = await Effect.runPromise(store.list({ sessionID: "ses_abc" }))
    expect(filtered).toHaveLength(2)

    const report = summarizeAgentEvents(filtered)
    expect(report.eventCount).toBe(2)
    expect(report.runCount).toBe(1)
    expect(report.modelCallCount).toBe(1)
    expect(report.toolCallCount).toBe(1)
    expect(report.inputTokens).toBe(100)
    expect(report.cachedInputTokens).toBe(40)
    expect(report.uncachedInputTokens).toBe(60)
    expect(report.outputTokens).toBe(20)
    expect(report.totalCost).toBe(0.5)
    expect(report.realizedCacheReadRatio).toBe(0.4)
    expect(report.byRole.coder?.events).toBe(2)
  })

  test("exports sanitized JSONL", async () => {
    const { storage } = makeStorage()
    const store = makeAgentTelemetryStore(storage, { keyFile: "unused", configuredKey: "e".repeat(64) })
    await Effect.runPromise(store.record(event({ occurredAt: 1 })))
    await Effect.runPromise(store.record(event({ occurredAt: 2 })))
    const events = await Effect.runPromise(store.list())
    const jsonl = exportAgentEvents(events)
    expect(jsonl.split("\n")).toHaveLength(2)
    expect(() => JSON.parse(jsonl.split("\n")[0]!)).not.toThrow()
  })

  test("prune drops expired non-terminal events but keeps terminal outcomes and caps the rest", async () => {
    const { storage } = makeStorage()
    const store = makeAgentTelemetryStore(storage, { keyFile: "unused", configuredKey: "f".repeat(64), now: () => 1_000 })
    await Effect.runPromise(
      store.record(event({ occurredAt: 10, eventType: "model.started", eventID: "old-non-terminal" })),
    )
    await Effect.runPromise(
      store.record(event({ occurredAt: 10, eventType: "model.finished", eventID: "old-terminal" })),
    )
    await Effect.runPromise(store.prune({ retentionMs: 100, maxEvents: 1 }))
    const remaining = await Effect.runPromise(store.list())
    const ids = remaining.map((item) => item.eventID)
    expect(ids).toContain("old-terminal")
    expect(ids).not.toContain("old-non-terminal")
  })

  test("all keys live under the agent-telemetry prefix", async () => {
    const { storage, values } = makeStorage()
    const store = makeAgentTelemetryStore(storage, { keyFile: "unused", configuredKey: "a".repeat(64) })
    await Effect.runPromise(store.record(event()))
    for (const key of values.keys()) expect(key.startsWith(AGENT_TELEMETRY_PREFIX)).toBe(true)
  })
})

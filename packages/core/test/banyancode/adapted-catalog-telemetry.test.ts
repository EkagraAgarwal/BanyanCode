/**
 * Tests for the Phase 5 graph-policy telemetry surface on `AdaptedCatalog`:
 * per-turn policy-event recording (`codegraph_policy_events`) and the
 * composite-key `recordUsage` aggregate, both exercised against a real DB so
 * the new migrations actually run.
 */

import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import {
  Service as AdaptedCatalog,
  defaultLayer as adaptedCatalogDefaultLayer,
} from "../../src/banyancode/adapted-catalog"

process.env.BANYANCODE_ENABLE = "1"

const setupLayers = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const catalogLayer = adaptedCatalogDefaultLayer.pipe(Layer.provide(dbLayer))
  return Layer.mergeAll(catalogLayer, dbLayer)
}

describe("AdaptedCatalog policy-event telemetry", () => {
  test("recordPolicyEvent appends one row per event; listPolicyEvents reads them back scoped by session", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "telemetry.db")
    const all = setupLayers(dbPath)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* AdaptedCatalog
        yield* catalog.recordPolicyEvent({
          sessionID: "ses_a",
          messageID: "m1",
          toolID: "read",
          eventType: "call",
          mode: "enforce",
          ts: 1,
          graphState: "ready",
        })
        yield* catalog.recordPolicyEvent({
          sessionID: "ses_a",
          messageID: "m1",
          toolID: "read",
          eventType: "redirect",
          mode: "enforce",
          ts: 2,
          graphState: "ready",
        })
        yield* catalog.recordPolicyEvent({
          sessionID: "ses_a",
          messageID: "m1",
          toolID: "code_find",
          eventType: "graph_attempt",
          mode: "enforce",
          ts: 3,
          graphState: "ready",
          outcome: "ok",
        })
        yield* catalog.recordPolicyEvent({
          sessionID: "ses_b",
          messageID: "m2",
          toolID: "grep",
          eventType: "call",
          mode: "advisory",
          ts: 4,
        })
        const scoped = yield* catalog.listPolicyEvents({ sessionID: "ses_a" })
        const allEvents = yield* catalog.listPolicyEvents()
        return { scoped, allEvents }
      }).pipe(Effect.provide(all), Effect.scoped),
    )

    // Newest first within the session scope.
    expect(result.scoped.map((e) => e.eventType)).toEqual(["graph_attempt", "redirect", "call"])
    expect(result.scoped.every((e) => e.sessionID === "ses_a")).toBe(true)
    expect(result.allEvents).toHaveLength(4)

    const attempt = result.scoped.find((e) => e.eventType === "graph_attempt")
    expect(attempt?.outcome).toBe("ok")
    expect(attempt?.graphState).toBe("ready")
    expect(attempt?.mode).toBe("enforce")
  })

  test("recordUsage aggregates every call through the wrapper so the denominator is accurate", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "telemetry-denominator.db")
    const all = setupLayers(dbPath)

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* AdaptedCatalog
        // V1 built-ins + a graph attempt: all through the same wrapper.
        for (const toolID of ["read", "grep", "bash", "read", "code_find"]) {
          yield* catalog.recordUsage(toolID, "ses_denom")
        }
        const { db } = yield* Database.Service
        return yield* db.all<{ tool_id: string; session_id: string; use_count: number }>(
          sql`SELECT tool_id, session_id, use_count FROM codegraph_tool_usage ORDER BY tool_id`,
        )
      }).pipe(Effect.provide(all), Effect.scoped),
    )

    // One composite row per (session, tool); the repeated read is counted.
    expect(rows).toEqual([
      { tool_id: "bash", session_id: "ses_denom", use_count: 1 },
      { tool_id: "code_find", session_id: "ses_denom", use_count: 1 },
      { tool_id: "grep", session_id: "ses_denom", use_count: 1 },
      { tool_id: "read", session_id: "ses_denom", use_count: 2 },
    ])
  })
})

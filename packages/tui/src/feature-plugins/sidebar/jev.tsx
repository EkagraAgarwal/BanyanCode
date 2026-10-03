/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { For, Show, createMemo } from "solid-js"
import { useSync } from "../../context/sync"
import { toHex } from "../../util/color"

const id = "internal:sidebar-jev"

export const JEV_SIDEBAR_ORDER = 159

// Compactness follows the sidebar-compact-spacing rule: the sidebar wrapper
// owns the inter-plugin gap, so the first content element uses marginTop={0}
// and at most MAX_ROWS single-line rows render.
const MAX_ROWS = 8
// Bounded aggregation window over persisted parts; the sync store already
// caps parts per message, this keeps the summarize pass O(1).
const MAX_PARTS = 200
const MAX_FEATURES = 8
const MAX_FEATURE_CHARS = 32

export interface JevFeatureRow {
  readonly feature: string
  readonly observed: number
  readonly completed: number
  readonly failed: number
  readonly skipped: number
  readonly running: number
  readonly latencyMs: number
  readonly latencyKnown: number
  readonly cost: number
  readonly costKnown: number
}

export interface JevSummary {
  readonly rows: ReadonlyArray<JevFeatureRow>
  readonly observed: number
  readonly cost: number | undefined
  readonly costKnown: number
}

const KNOWN_STATUSES = new Set(["running", "completed", "failed", "skipped"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isJevActivityPart(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === "jev_activity"
}

function asFeature(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "")
    return (
      value
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
        .trim()
        .slice(0, MAX_FEATURE_CHARS) || "unknown"
    )
  return "unknown"
}

function asMillis(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const ms = (value as { ms?: unknown }).ms
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined
  return ms
}

function asCost(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const cost = (value as { cost?: unknown }).cost
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return undefined
  return cost
}

// Pure aggregation over persisted jev_activity parts. Counts are labelled
// "observed decisions" — they count durable part rows, never physical Jev
// API calls (retries, cache hits, and avoided-work estimates are not
// visible here). Cost sums only parts that carry an explicit usage.cost;
// when none do, cost is undefined and the panel reports "cost n/a" rather
// than inventing a number. Choice/summary/state text is never read, so no
// prompt content can leak through this surface.
export function summarizeJevParts(parts: ReadonlyArray<unknown>, sessionID: string | undefined): JevSummary {
  const windowed: Array<Record<string, unknown>> = []
  for (let index = parts.length - 1; index >= 0 && windowed.length < MAX_PARTS; index -= 1) {
    const part = parts[index]
    if (!isJevActivityPart(part)) continue
    if (sessionID !== undefined && part.sessionID !== sessionID) continue
    windowed.push(part)
  }
  const bounded = windowed.reverse()
  const byFeature = new Map<string, JevFeatureRow>()
  let cost = 0
  let costKnown = 0
  for (const part of bounded) {
    const label = asFeature(part.feature)
    const feature = byFeature.has(label) || byFeature.size < MAX_FEATURES - 1 ? label : "other"
    let row = byFeature.get(feature)
    if (!row) {
      row = {
        feature,
        observed: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
        running: 0,
        latencyMs: 0,
        latencyKnown: 0,
        cost: 0,
        costKnown: 0,
      }
    }
    const status = typeof part.status === "string" && KNOWN_STATUSES.has(part.status) ? part.status : undefined
    const next: JevFeatureRow = {
      ...row,
      observed: row.observed + 1,
      completed: row.completed + Number(status === "completed"),
      failed: row.failed + Number(status === "failed"),
      skipped: row.skipped + Number(status === "skipped"),
      running: row.running + Number(status === "running"),
    }
    const latency = asMillis(part.latency)
    const withLatency: JevFeatureRow =
      latency === undefined ? next : { ...next, latencyMs: row.latencyMs + latency, latencyKnown: row.latencyKnown + 1 }
    const partCost = asCost(part.usage)
    const finalRow: JevFeatureRow =
      partCost === undefined ? withLatency : { ...withLatency, cost: row.cost + partCost, costKnown: row.costKnown + 1 }
    byFeature.set(feature, finalRow)
    if (partCost !== undefined) {
      cost += partCost
      costKnown += 1
    }
  }
  const rows = [...byFeature.values()].sort((a, b) => b.observed - a.observed).slice(0, MAX_ROWS)
  return {
    rows,
    observed: bounded.length,
    cost: costKnown > 0 ? cost : undefined,
    costKnown,
  }
}

function rowLine(row: JevFeatureRow): string {
  const segments = [`${row.observed} observed`, `${row.completed} ok`]
  if (row.failed > 0) segments.push(`${row.failed} failed`)
  if (row.skipped > 0) segments.push(`${row.skipped} skipped`)
  if (row.running > 0) segments.push(`${row.running} running`)
  if (row.latencyKnown > 0) segments.push(`avg ${Math.round(row.latencyMs / row.latencyKnown)}ms`)
  return `${row.feature} · ${segments.join(" · ")}`
}

export function JevView(props: { api: TuiPluginApi; session_id: string; parts?: ReadonlyArray<unknown> }) {
  const theme = () => props.api.theme.current
  const sync = useSync()

  const summary = createMemo<JevSummary>(() => {
    if (props.parts !== undefined) return summarizeJevParts(props.parts, props.session_id)
    const stored: Array<unknown> = []
    const messages = sync.data.message[props.session_id] ?? []
    for (const message of messages.slice(-MAX_PARTS)) {
      const list = sync.data.part[message.id] ?? []
      for (const part of list) stored.push(part)
    }
    return summarizeJevParts(stored, props.session_id)
  })

  const costLine = () => {
    const current = summary()
    if (current.cost === undefined) return "cost n/a"
    return `cost $${current.cost.toFixed(4)} · ${current.costKnown} of ${current.observed} known`
  }

  return (
    <Show when={summary().observed > 0}>
      <box flexDirection="column" gap={0}>
        <box flexDirection="row" gap={1} alignItems="center" marginTop={0}>
          <text fg={toHex(theme().primary)}>
            <b>JEV</b>
          </text>
          <text fg={toHex(theme().textMuted)}>{summary().observed} observed decisions</text>
        </box>
        <text fg={toHex(theme().textMuted)} wrapMode="none" marginTop={0}>
          {costLine()}
        </text>
        <For each={summary().rows}>
          {(row) => (
            <text fg={toHex(theme().textMuted)} wrapMode="none" marginTop={0}>
              {rowLine(row)}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: JEV_SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx, props) {
        return <JevView api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

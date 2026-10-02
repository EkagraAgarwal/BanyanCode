/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import stripAnsi from "strip-ansi"
import { useTheme } from "../context/theme"
import { Spinner, shouldSpinSpinner } from "./spinner"
import { useSync } from "../context/sync"
import { Locale } from "../util/locale"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

export type JevRunStatus = "running" | "completed" | "handoff" | "failed" | "cancelled"
export type JevRunNodeStatus = "done" | "failed" | "skipped"
export type JevRunEvidence = { path: string; lines?: string; excerpt?: string }

export type JevRunNode = {
  nodeID: string
  parentID?: string
  actionID: string
  target: string
  status: JevRunNodeStatus
  evidence?: JevRunEvidence[]
  confidence?: number
  latencyMs?: number
}

// Local mirror of the frozen `jev_run` part contract. The SDK regen lands
// separately, so the TUI validates the wire shape itself instead of casting.
export type JevRunPartData = {
  id: string
  sessionID: string
  messageID: string
  type: "jev_run"
  runID: string
  status: JevRunStatus
  nodes: JevRunNode[]
  stopReason?: string
  usage?: { input: number; output: number; cost?: number }
}

const RUN_STATUSES: JevRunStatus[] = ["running", "completed", "handoff", "failed", "cancelled"]
const NODE_STATUSES: JevRunNodeStatus[] = ["done", "failed", "skipped"]
const COLLAPSE_AT = 8

// Optional fields treat null/undefined alike: publishers omit them differently
// after JSON round-trips, but a wrong type still fails the whole part.
const absent = (value: unknown) => value === undefined || value === null
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value)

function isEvidence(value: unknown): boolean {
  if (absent(value)) return true
  if (!Array.isArray(value)) return false
  return value.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false
    const ev = entry as Record<string, unknown>
    if (typeof ev.path !== "string") return false
    if (!absent(ev.lines) && typeof ev.lines !== "string") return false
    if (!absent(ev.excerpt) && typeof ev.excerpt !== "string") return false
    return true
  })
}

function isNode(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const node = value as Record<string, unknown>
  if (typeof node.nodeID !== "string" || node.nodeID.length === 0) return false
  if (!absent(node.parentID) && (typeof node.parentID !== "string" || node.parentID.length === 0)) return false
  if (typeof node.actionID !== "string") return false
  if (typeof node.target !== "string") return false
  if (!NODE_STATUSES.some((status) => status === node.status)) return false
  if (!absent(node.confidence) && !finite(node.confidence)) return false
  if (!absent(node.latencyMs) && !finite(node.latencyMs)) return false
  if (!isEvidence(node.evidence)) return false
  return true
}

export function isJevRunPart(part: unknown): part is JevRunPartData {
  if (typeof part !== "object" || part === null) return false
  const value = part as Record<string, unknown>
  if (value.type !== "jev_run") return false
  if (typeof value.id !== "string" || typeof value.sessionID !== "string" || typeof value.messageID !== "string")
    return false
  if (typeof value.runID !== "string" || value.runID.length === 0) return false
  if (!RUN_STATUSES.some((status) => status === value.status)) return false
  if (!Array.isArray(value.nodes) || !value.nodes.every(isNode)) return false
  if (!absent(value.stopReason) && typeof value.stopReason !== "string") return false
  if (absent(value.usage)) return true
  if (typeof value.usage !== "object" || value.usage === null) return false
  const usage = value.usage as Record<string, unknown>
  if (!finite(usage.input) || !finite(usage.output)) return false
  if (!absent(usage.cost) && !finite(usage.cost)) return false
  return true
}

// Display-only sanitizer (defense in depth for already-stored rows): strip
// ANSI + control characters, collapse to a single line, clamp rendered size.
const display = (value: string | undefined, max: number) => {
  if (!value) return ""
  const cleaned = stripAnsi(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned.length > max ? cleaned.slice(0, Math.max(1, max - 1)) + "…" : cleaned
}

const confidenceLabel = (value: number | undefined) => {
  if (value === undefined || !Number.isFinite(value)) return ""
  const pct = value >= 0 && value <= 1 ? Math.round(value * 100) : Math.round(value)
  return ` · ${Math.min(100, Math.max(0, pct))}%`
}

const evidenceLabel = (ev: JevRunEvidence) => {
  const file = display(ev.path, 200)
  const lines = display(ev.lines, 64)
  const excerpt = display(ev.excerpt, 200)
  return [lines ? `${file}:${lines}` : file, excerpt].filter(Boolean).join(" · ")
}

const nodeGlyph = (status: JevRunNodeStatus) => (status === "done" ? "✓" : status === "failed" ? "✗" : "–")

type Row = { node: JevRunNode; depth: number }

// Depth-first flatten: children indent under their parent (parentID resolved),
// orphans and parentless chains start at the root, cycles never disappear.
const flatten = (nodes: JevRunNode[]): Row[] => {
  const byParent = new Map<string, JevRunNode[]>()
  for (const node of nodes) {
    const key = node.parentID ?? ""
    const bucket = byParent.get(key)
    if (bucket) bucket.push(node)
    else byParent.set(key, [node])
  }
  const known = new Set(nodes.map((node) => node.nodeID))
  const seen = new Set<string>()
  const rows: Row[] = []
  const walk = (node: JevRunNode, depth: number) => {
    if (seen.has(node.nodeID)) return
    seen.add(node.nodeID)
    rows.push({ node, depth })
    for (const child of byParent.get(node.nodeID) ?? []) walk(child, depth + 1)
  }
  for (const node of nodes) {
    const orphan =
      node.parentID === undefined || node.parentID === node.nodeID || !known.has(node.parentID)
    if (orphan) walk(node, 0)
  }
  for (const node of nodes) walk(node, 0)
  return rows
}

export function JevRunTree(props: { last: boolean; part: unknown; message: AssistantMessage }) {
  const { theme } = useTheme()
  const sync = useSync()
  const data = createMemo(() => (isJevRunPart(props.part) ? props.part : undefined))
  const id = createMemo(() => "jev-run-" + (data()?.runID ?? ""))
  const status = createMemo(() => data()?.status)
  const nodes = createMemo(() => data()?.nodes ?? [])
  const rows = createMemo(() => flatten(nodes()))
  const [expanded, setExpanded] = createSignal(false)
  const visibleRows = createMemo(() => (expanded() ? rows() : rows().slice(0, COLLAPSE_AT)))
  const hiddenCount = createMemo(() => Math.max(0, rows().length - visibleRows().length))
  const countLabel = createMemo(() => `${rows().length} ${rows().length === 1 ? "node" : "nodes"}`)
  const stopReason = createMemo(() => display(data()?.stopReason, 200))
  const latency = createMemo(() => {
    const values = nodes().flatMap((node) =>
      node.latencyMs !== undefined && Number.isFinite(node.latencyMs) && node.latencyMs >= 0 ? [node.latencyMs] : [],
    )
    return values.length > 0 ? values.reduce((total, ms) => total + ms, 0) : undefined
  })
  const usage = createMemo(() => {
    const value = data()?.usage
    if (!value) return ""
    const input = Number.isFinite(value.input) ? Math.max(0, Math.round(value.input)) : 0
    const output = Number.isFinite(value.output) ? Math.max(0, Math.round(value.output)) : 0
    const cost =
      typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0
        ? ` · $${value.cost.toFixed(4)}`
        : ""
    return `${input}↑ ${output}↓ tok${cost}`
  })
  const summary = createMemo(() =>
    [latency() !== undefined ? Locale.duration(latency()!) : "", usage()].filter(Boolean).join(" · "),
  )
  const header = createMemo(() => `Jev · explore-tree · ${status()} · ${countLabel()}`)
  // A `running` Jev part from a dead turn must not animate once the owning
  // message is complete or the session is idle.
  const spinning = createMemo(() =>
    shouldSpinSpinner({
      partRunning: status() === "running",
      messageCompleted: props.message.time?.completed !== undefined,
      sessionStatus: sync.data.session_status[props.message.sessionID],
    }),
  )
  const statusColor = createMemo(() =>
    status() === "completed"
      ? theme.diffAdded
      : status() === "failed"
        ? theme.diffRemoved
        : status() === "running"
          ? theme.warning
          : status() === "handoff"
            ? theme.primary
            : theme.textMuted,
  )
  const statusGlyph = createMemo(() =>
    status() === "completed"
      ? "✓"
      : status() === "failed"
        ? "✗"
        : status() === "cancelled"
          ? "–"
          : status() === "handoff"
            ? "→"
            : "",
  )
  const nodeColor = (nodeStatus: JevRunNodeStatus) =>
    nodeStatus === "done" ? theme.diffAdded : nodeStatus === "failed" ? theme.diffRemoved : theme.textMuted

  return (
    <Show when={data()}>
      <box id={id()} paddingLeft={3} marginTop={1} flexDirection="column" flexShrink={0}>
        <Switch>
          <Match when={spinning()}>
            <Spinner color={theme.warning}>{"◇ " + header()}</Spinner>
          </Match>
          <Match when={true}>
            <text fg={theme.textMuted} wrapMode="word">
              <span style={{ fg: statusColor() }}>{statusGlyph()} </span>
              <span style={{ fg: theme.text }}>Jev · explore-tree</span>
              <span style={{ fg: statusColor() }}> · {status()}</span>
              <span> · {countLabel()}</span>
            </text>
          </Match>
        </Switch>
        <Show when={summary()}>
          <text fg={theme.textMuted} wrapMode="none">
            {summary()}
          </text>
        </Show>
        <For each={visibleRows()}>
          {(row) => (
            <box flexDirection="column">
              <box flexDirection="row" paddingLeft={row.depth * 2}>
                <text flexShrink={0} fg={nodeColor(row.node.status)}>
                  {nodeGlyph(row.node.status) + " "}
                </text>
                <text wrapMode="word" fg={theme.textMuted}>
                  <span style={{ fg: theme.text }}>{display(row.node.actionID, 64)}</span>{" "}
                  {display(row.node.target, 120)}
                  <Show when={row.node.confidence !== undefined}>
                    <span>{confidenceLabel(row.node.confidence)}</span>
                  </Show>
                </text>
              </box>
              <Show when={row.node.evidence && row.node.evidence.length > 0}>
                <box flexDirection="column" paddingLeft={row.depth * 2 + 2}>
                  <For each={row.node.evidence}>
                    {(ev) => (
                      <text fg={theme.textMuted} wrapMode="word">
                        {evidenceLabel(ev)}
                      </text>
                    )}
                  </For>
                </box>
              </Show>
            </box>
          )}
        </For>
        <Show when={rows().length > COLLAPSE_AT}>
          <box onMouseUp={() => setExpanded((prev) => !prev)}>
            <text fg={theme.textMuted}>{expanded() ? "show less" : `+${hiddenCount()} more`}</text>
          </box>
        </Show>
        <Show when={stopReason()}>
          <text fg={theme.textMuted} wrapMode="word">
            {stopReason()}
          </text>
        </Show>
        <Show when={status() === "handoff"}>
          <text fg={theme.primary} wrapMode="word">
            → continued by model
          </text>
        </Show>
      </box>
    </Show>
  )
}

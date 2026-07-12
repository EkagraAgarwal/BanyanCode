/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, createResource, createMemo, onCleanup, onMount, For, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { useDialog } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { DialogAlert } from "../../ui/dialog-alert"
import { RoundedBorder } from "../../ui/border.ts"
import { toHex } from "../../util/color"
import { errorMessage } from "../../util/error"
import { openAddMemoryDialog } from "../../component/dialog-memory-add"

const id = "internal:tabs-tab-memory"

interface MemoryEntry {
  id: string
  key: string
  version: number
  agentID?: string
  value: unknown
  kind?: string
  title?: string
  body?: string
  status?: string
  scope?: "global" | "session"
  tags?: string[]
  context?: string
  updatedAt?: number
  sessionID?: string
}

interface MemorySummary {
  totalActive: number
  byKind: Array<{ kind: string; count: number }>
  decisionDigest: Array<{ id: string; kind: string; title: string; body: string }>
  warningDigest: Array<{ id: string; kind: string; title: string; body: string }>
  generatedAt: number
}

type ScopeFilter = "global" | "session"

const KIND_SECTIONS: Array<{ key: string; label: string }> = [
  { key: "preference", label: "Preferences" },
  { key: "decision", label: "Decisions" },
  { key: "convention", label: "Conventions" },
  { key: "architecture", label: "Architecture" },
  { key: "pattern", label: "Patterns" },
  { key: "warning", label: "Warnings" },
  { key: "failure", label: "Failures" },
  { key: "todo", label: "Todos" },
  { key: "observation", label: "Observations" },
  { key: "summary", label: "Summaries" },
  { key: "ownership", label: "Ownership" },
  { key: "constraint", label: "Constraints" },
  { key: "environment", label: "Environment" },
  { key: "identity", label: "Identity" },
]

function timeAgo(ts?: number) {
  if (!ts) return "—"
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function statusGlyph(status?: string) {
  switch (status) {
    case "pending":
      return { glyph: "◌", color: "warning" as const }
    case "active":
      return { glyph: "●", color: "success" as const }
    case "superseded":
      return { glyph: "○", color: "textMuted" as const }
    case "rejected":
      return { glyph: "✕", color: "error" as const }
    default:
      return { glyph: "·", color: "textMuted" as const }
  }
}

function previewBody(e: MemoryEntry): string {
  if (e.body) return e.body.slice(0, 80)
  if (typeof e.value === "string") return e.value.slice(0, 80)
  if (e.value && typeof e.value === "object") return JSON.stringify(e.value).slice(0, 80)
  return ""
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const event = useEvent()
  const dialog = useDialog()
  const [refreshTrigger, setRefreshTrigger] = createSignal(0)
  const [scope, setScope] = createSignal<ScopeFilter>("global")
  const [kindFilter, setKindFilter] = createSignal<string>("all")
  const [showSummary, setShowSummary] = createSignal(true)
  const [actionError, setActionError] = createSignal<string | null>(null)

  const notify = (message: string) => {
    void props.api.attention.notify({ message, notification: false, sound: false })
  }

  const [entries] = createResource(
    () => ({ scope: scope(), trigger: refreshTrigger() }),
    async (source) => {
      try {
        const filterStatus = undefined
        const filterKind = undefined
        const result = await props.api.client.memory.list({
          banyanMemoryListInput: {
            scope: source.scope,
            status: filterStatus,
            kind: filterKind,
            limit: 100,
          },
        })
        return ((result as any)?.data ?? []) as MemoryEntry[]
      } catch {
        return []
      }
    }
  )

  const [candidates] = createResource(
    () => ({ scope: scope(), trigger: refreshTrigger() }),
    async (source) => {
      try {
        const result = await props.api.client.memory.candidates({
          banyanMemoryCandidatesInput: { scope: source.scope, status: "pending", limit: 100 },
        })
        const data = (result as any)?.data
        return ((data?.entries ?? (Array.isArray(data) ? data : [])) as MemoryEntry[])
      } catch {
        return []
      }
    }
  )

  const [summary, { refetch: refetchSummary }] = createResource(
    () => ({ scope: scope(), trigger: refreshTrigger() }),
    async (source) => {
      try {
        const result = await props.api.client.memory.summary({
          banyanMemorySummaryInput: { scope: source.scope, maxItems: 25 },
        })
        const data = (result as any)?.data as MemorySummary | undefined
        return data ?? null
      } catch {
        return null
      }
    },
  )

  onMount(() => {
    const unsubs = [
      event.on("banyancode.memory.candidate_emitted", () => {
        setRefreshTrigger((n) => n + 1)
      }),
      event.on("banyancode.memory.committed", () => {
        setRefreshTrigger((n) => n + 1)
      }),
      event.on("banyancode.memory.promoted", () => {
        setRefreshTrigger((n) => n + 1)
      }),
      event.on("banyancode.memory.rejected", () => {
        setRefreshTrigger((n) => n + 1)
      }),
    ]
    onCleanup(() => {
      for (const u of unsubs) u()
    })
  })

  const filteredEntries = createMemo<MemoryEntry[]>(() => {
    const c = candidates() ?? []
    const e = entries() ?? []
    const seen = new Set<string>()
    const merged: MemoryEntry[] = []
    for (const item of [...c, ...e]) {
      if (!seen.has(item.id)) {
        seen.add(item.id)
        merged.push(item)
      }
    }
    const kFilter = kindFilter()
    const filtered = merged.filter((item) => {
      const kind = item.kind ?? "observation"
      return kFilter === "all" || kind === kFilter
    })
    return filtered.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  })

  const showDetail = (entry: MemoryEntry) => {
    const lines = [
      `id: ${entry.id}`,
      `key: ${entry.key}`,
      `version: v${entry.version}`,
      `kind: ${entry.kind ?? "—"}`,
      `title: ${entry.title ?? "—"}`,
      `status: ${entry.status ?? "active"}`,
      `scope: ${entry.scope ?? "—"}`,
      `agentID: ${entry.agentID ?? "—"}`,
      `sessionID: ${entry.sessionID ?? "—"}`,
      `tags: ${(entry.tags ?? []).join(", ") || "—"}`,
      `updated: ${entry.updatedAt ? new Date(entry.updatedAt).toISOString() : "—"}`,
      "",
      "body:",
      entry.body ?? JSON.stringify(entry.value, null, 2),
    ]
    dialog.replace(() => <DialogAlert title={entry.key} message={lines.join("\n")} />)
  }

  const forget = async (entry: MemoryEntry) => {
    const ok = await DialogConfirm.show(
      dialog,
      "Forget memory entry",
      `Forget "${entry.key}" (id=${entry.id})? This removes the row entirely.`,
    )
    if (!ok) return
    try {
      const result = await props.api.client.memory.forget({
        banyanMemoryForgetInput: { id: entry.id },
      })
      if ((result as any)?.error) {
        setActionError(errorMessage((result as any).error))
        return
      }
      notify(`Forgotten ${entry.key}`)
      setRefreshTrigger((n) => n + 1)
    } catch (e) {
      setActionError(errorMessage(e))
    }
  }

  const promote = async (entry: MemoryEntry) => {
    try {
      const result = await props.api.client.memory.promote({
        banyanMemoryPromoteInput: {
          id: entry.id,
          expectedVersion: entry.version,
        },
      })
      if ((result as any)?.error) {
        setActionError(errorMessage((result as any).error))
        return
      }
      notify(`Promoted ${entry.key}`)
      setRefreshTrigger((n) => n + 1)
    } catch (e) {
      setActionError(errorMessage(e))
    }
  }

  const reject = async (entry: MemoryEntry) => {
    const ok = await DialogConfirm.show(
      dialog,
      "Reject candidate",
      `Reject "${entry.key}" (id=${entry.id})? This marks the entry status=rejected.`,
    )
    if (!ok) return
    try {
      const result = await props.api.client.memory.reject({
        banyanMemoryRejectInput: {
          id: entry.id,
          expectedVersion: entry.version,
        },
      })
      if ((result as any)?.error) {
        setActionError(errorMessage((result as any).error))
        return
      }
      notify(`Rejected ${entry.key}`)
      setRefreshTrigger((n) => n + 1)
    } catch (e) {
      setActionError(errorMessage(e))
    }
  }

  const openAdd = () => {
    openAddMemoryDialog(props.api, dialog)
  }

  const refreshAll = () => {
    setRefreshTrigger((n) => n + 1)
    void refetchSummary()
  }

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
      >
        <text fg={toHex(theme().text)}>
          <b>Memory</b>
        </text>
        <box flexDirection="row" gap={2}>
          <text fg={toHex(theme().primary)} onMouseUp={openAdd}>
            [+ Add memory]
          </text>
          <text fg={toHex(theme().info)} onMouseUp={refreshAll}>
            [↻]
          </text>
        </box>
      </box>

      <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2} paddingTop={1}>
        <text fg={toHex(theme().textMuted)}>scope:</text>
        <text
          fg={toHex(scope() === "global" ? theme().primary : theme().textMuted)}
          onMouseUp={() => {
            setScope("global")
            setRefreshTrigger((n) => n + 1)
          }}
        >
          [global]
        </text>
        <text
          fg={toHex(scope() === "session" ? theme().primary : theme().textMuted)}
          onMouseUp={() => {
            setScope("session")
            setRefreshTrigger((n) => n + 1)
          }}
        >
          [session]
        </text>
      </box>

      <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2} paddingTop={1}>
        <text fg={toHex(theme().textMuted)}>kind: </text>
        <For each={["all", "fact", "decision", "preference", "file-note"]}>
          {(k) => (
            <text
              fg={toHex(kindFilter() === k ? theme().primary : theme().textMuted)}
              onMouseUp={() => setKindFilter(k)}
            >
              [{k}]
            </text>
          )}
        </For>
      </box>

      <Show when={showSummary()}>
        <SummaryCard
          theme={theme()}
          summary={summary() ?? null}
          loading={summary.loading}
          onRefresh={() => void refetchSummary()}
          onHide={() => setShowSummary(false)}
        />
      </Show>

      <Show when={actionError()}>
        <box paddingLeft={2} paddingTop={1}>
          <text fg={toHex(theme().error)}>{actionError()}</text>
        </box>
      </Show>

      <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
        <box flexDirection="column" paddingTop={1} gap={0}>
          <Show when={entries() !== undefined && candidates() !== undefined} fallback={<LoadingState theme={theme()} />}>
            <Show
              when={filteredEntries().length > 0}
              fallback={
                <EmptyState
                  theme={theme()}
                  message="No memory entries"
                  hint="Memory is populated as agents work; it persists across sessions."
                />
              }
            >
              <For each={filteredEntries()}>
                {(entry) => (
                  <box paddingLeft={1} paddingRight={1} paddingBottom={1}>
                    <MemoryCard
                      entry={entry}
                      theme={theme()}
                      timeAgo={timeAgo}
                      onShow={showDetail}
                      onPromote={promote}
                      onReject={reject}
                      onForget={forget}
                    />
                  </box>
                )}
              </For>
            </Show>
          </Show>
        </box>
      </scrollbox>
    </box>
  )
}

function GroupLabel(props: { label: string; theme: any }) {
  return (
    <text fg={toHex(props.theme.textMuted)} paddingLeft={2} paddingTop={1}>
      <b>{props.label}</b>
    </text>
  )
}

function SummaryCard(props: {
  theme: any
  summary: MemorySummary | null
  loading: boolean
  onRefresh: () => void
  onHide: () => void
}) {
  const kinds = () => {
    const items = props.summary?.byKind ?? []
    if (items.length === 0) return "no kinds"
    return items.map((s) => `${s.kind}=${s.count}`).join(", ")
  }
  const decisionItems = () => props.summary?.decisionDigest ?? []
  const warningItems = () => props.summary?.warningDigest ?? []
  return (
    <box
      flexDirection="column"
      marginTop={1}
      marginLeft={2}
      marginRight={2}
      border={["left", "right", "top", "bottom"]}
      borderColor={props.theme.border}
      customBorderChars={RoundedBorder.customBorderChars}
    >
      <box
        flexDirection="column"
        backgroundColor={props.theme.background}
        width="100%"
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
        gap={0}
      >
        <box flexDirection="row" gap={1} alignItems="center" marginTop={0} marginBottom={0}>
          <text fg={toHex(props.theme.success)}>●</text>
          <text fg={toHex(props.theme.text)}>
            <b>{props.summary?.totalActive ?? 0}</b> active · {kinds()}
          </text>
        </box>
        <Show when={props.loading && !props.summary}>
          <text fg={toHex(props.theme.textMuted)} marginTop={0}>loading…</text>
        </Show>
        <Show when={!props.loading && decisionItems().length > 0}>
          <box flexDirection="column" marginTop={0} marginBottom={0}>
            <text fg={toHex(props.theme.success)}>Decisions</text>
            <For each={decisionItems().slice(0, 3)}>
              {(d) => (
                <text fg={toHex(props.theme.textMuted)}>
                  {"  "}• [{d.kind}] {d.title}
                </text>
              )}
            </For>
          </box>
        </Show>
        <Show when={!props.loading && warningItems().length > 0}>
          <box flexDirection="column" marginTop={0} marginBottom={0}>
            <text fg={toHex(props.theme.warning)}>Warnings</text>
            <For each={warningItems().slice(0, 3)}>
              {(d) => (
                <text fg={toHex(props.theme.textMuted)}>
                  {"  "}• [{d.kind}] {d.title}
                </text>
              )}
            </For>
          </box>
        </Show>
        <box flexDirection="row" gap={2} marginTop={0} marginBottom={0}>
          <text fg={toHex(props.theme.info)} onMouseUp={props.onRefresh}>
            refresh
          </text>
          <text fg={toHex(props.theme.textMuted)} onMouseUp={props.onHide}>
            hide
          </text>
        </box>
      </box>
    </box>
  )
}

function LoadingState(props: { theme: any }) {
  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={2} gap={1}>
      <box flexDirection="row" gap={2} alignItems="center">
        <text fg={toHex(props.theme.primary)}>◌</text>
        <text fg={toHex(props.theme.textMuted)}>Loading memory…</text>
      </box>
    </box>
  )
}

function EmptyState(props: { theme: any; message: string; hint: string }) {
  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={2} gap={1}>
      <box flexDirection="row" gap={2} alignItems="center">
        <text fg={toHex(props.theme.textMuted)}>∅</text>
        <text fg={toHex(props.theme.text)}>{props.message}</text>
      </box>
      <box paddingLeft={4}>
        <text fg={toHex(props.theme.textMuted)}>{props.hint}</text>
      </box>
    </box>
  )
}

function MemoryCard(props: {
  entry: MemoryEntry
  theme: any
  timeAgo: (ts?: number) => string
  onShow: (e: MemoryEntry) => void
  onPromote: (e: MemoryEntry) => void | Promise<void>
  onReject: (e: MemoryEntry) => void | Promise<void>
  onForget: (e: MemoryEntry) => void | Promise<void>
}) {
  const status = () => statusGlyph(props.entry.status)
  const show = () => props.onShow(props.entry)
  const isPending = () => props.entry.status === "pending"
  return (
    <box
      flexDirection="column"
      border={["left", "right", "top", "bottom"]}
      borderColor={props.theme.border}
      customBorderChars={RoundedBorder.customBorderChars}
    >
      <box
        flexDirection="column"
        backgroundColor={props.theme.background}
        width="100%"
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
        gap={0}
      >
        <box flexDirection="row" gap={1} alignItems="center" marginTop={0} marginBottom={0}>
          <text fg={toHex(props.theme[status().color])}>{status().glyph}</text>
          <text fg={toHex(props.theme.primary)}>
            <b>{props.entry.kind ?? "observation"}:{props.entry.key}</b>
          </text>
          <text fg={toHex(props.theme.textMuted)}>v{props.entry.version}</text>
          <box flexGrow={1} justifyContent="flex-end" flexDirection="row">
            <text fg={toHex(props.theme.textMuted)}>{props.timeAgo(props.entry.updatedAt)}</text>
          </box>
        </box>
        <text fg={toHex(props.theme.textMuted)} marginTop={0} marginBottom={0}>
          {previewBody(props.entry)}
        </text>
        <box flexDirection="row" gap={2} paddingTop={0} marginTop={0} marginBottom={0}>
          <text fg={toHex(props.theme.info)} onMouseUp={show}>
            open
          </text>
          <Show when={isPending()}>
            <text fg={toHex(props.theme.success)} onMouseUp={() => props.onPromote(props.entry)}>
              promote
            </text>
            <text fg={toHex(props.theme.error)} onMouseUp={() => props.onReject(props.entry)}>
              reject
            </text>
          </Show>
          <text fg={toHex(props.theme.error)} onMouseUp={() => props.onForget(props.entry)}>
            forget
          </text>
        </box>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 30,
    slots: {
      session_tab_memory() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

// PENDING CANDIDATES

export default plugin
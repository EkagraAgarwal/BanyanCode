/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, createResource, createMemo, onCleanup, onMount, For, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { useDialog } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { DialogAlert } from "../../ui/dialog-alert"
import { toHex } from "../../util/color"
import { errorMessage } from "../../util/error"

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
type StatusFilter = "pending" | "active" | "superseded" | "rejected"
type KindFilter = "any" | string

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
  const [statusFilter, setStatusFilter] = createSignal<"any" | StatusFilter>("active")
  const [kindFilter, setKindFilter] = createSignal<KindFilter>("any")
  const [showSummary, setShowSummary] = createSignal(true)

  const statusForBackend = (s: "any" | StatusFilter) =>
    s === "any" ? undefined : (s as "active" | "pending" | "superseded" | "rejected")
  const kindForBackend = (k: KindFilter) =>
    k === "any" ? undefined : (k as "preference" | "decision" | "convention" | "architecture" | "pattern" | "warning" | "failure" | "todo" | "observation" | "summary" | "ownership" | "constraint" | "environment" | "identity")
  const [actionError, setActionError] = createSignal<string | null>(null)

  const notify = (message: string) => {
    void props.api.attention.notify({ message, notification: false, sound: false })
  }

  const [entries] = createResource<MemoryEntry[], number>(refreshTrigger, async (n) => {
    n
    try {
      const filterStatus = statusForBackend(statusFilter())
      const filterKind = kindForBackend(kindFilter())
      const result = await props.api.client.memory.search({
        banyanMemorySearchInput: {
          limit: 100,
          scope: scope(),
          status: filterStatus,
          kind: filterKind,
          query: "",
        },
      })
      const data = (result as any)?.data
      if (result.error || !data) {
        // Fall back to the list endpoint when search rejects an empty query.
        const listResult = await props.api.client.memory.list({
          banyanMemoryListInput: {
            scope: scope(),
            status: filterStatus,
            kind: filterKind,
            limit: 100,
          },
        })
        return ((listResult as any)?.data ?? []) as MemoryEntry[]
      }
      const payload = data as { entries?: MemoryEntry[] }
      return payload.entries ?? ((Array.isArray(data) ? data : []) as MemoryEntry[])
    } catch {
      return []
    }
  })

  const [candidates] = createResource<MemoryEntry[], number>(refreshTrigger, async () => {
    try {
      const result = await props.api.client.memory.candidates({
        banyanMemoryCandidatesInput: { scope: scope(), status: "pending", limit: 100 },
      })
      const data = (result as any)?.data
      return ((data?.entries ?? (Array.isArray(data) ? data : [])) as MemoryEntry[])
    } catch {
      return []
    }
  })

  const [summary, { refetch: refetchSummary }] = createResource<MemorySummary | null, number>(
    refreshTrigger,
    async () => {
      try {
        const result = await props.api.client.memory.summary({
          banyanMemorySummaryInput: { scope: scope(), maxItems: 25 },
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

  const allActive = createMemo<MemoryEntry[]>(() => {
    const list = entries() ?? []
    return list.filter((e) => (statusFilter() === "any" ? true : e.status === statusFilter()))
  })

  const grouped = createMemo<Map<string, MemoryEntry[]>>(() => {
    const map = new Map<string, MemoryEntry[]>()
    for (const e of allActive()) {
      const kind = e.kind ?? "observation"
      const arr = map.get(kind) ?? []
      arr.push(e)
      map.set(kind, arr)
    }
    return map
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

  const candidatesList = () => candidates() ?? []

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
      </box>

      <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2} paddingTop={1}>
        <text fg={toHex(theme().textMuted)}>status:</text>
        <For each={["any", "active", "pending", "superseded", "rejected"]}>
          {(s) => (
            <text
              fg={toHex(statusFilter() === s ? theme().primary : theme().textMuted)}
              onMouseUp={() => {
                setStatusFilter(s as any)
                setRefreshTrigger((n) => n + 1)
              }}
            >
              [{s}]
            </text>
          )}
        </For>
        <text fg={toHex(theme().textMuted)}> | kind:</text>
        <text
          fg={toHex(kindFilter() === "any" ? theme().primary : theme().textMuted)}
          onMouseUp={() => {
            setKindFilter("any")
            setRefreshTrigger((n) => n + 1)
          }}
        >
          [any]
        </text>
        <text fg={toHex(theme().textMuted)}> | </text>
        <text
          fg={toHex(showSummary() ? theme().primary : theme().textMuted)}
          onMouseUp={() => setShowSummary((v) => !v)}
        >
          [summary]
        </text>
        <text
          fg={toHex(theme().info)}
          onMouseUp={() => {
            void refetchSummary()
          }}
        >
          refresh
        </text>
      </box>

      <Show when={showSummary()}>
        <SummaryPanel
          theme={theme()}
          summary={summary() ?? null}
          loading={summary.loading}
        />
      </Show>

      <Show when={actionError()}>
        <box paddingLeft={2} paddingTop={1}>
          <text fg={toHex(theme().error)}>{actionError()}</text>
        </box>
      </Show>

      <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
        <box flexDirection="column" paddingTop={1}>
          <Show when={entries() !== undefined} fallback={<LoadingState theme={theme()} />}>
            <Show when={candidatesList().length > 0}>
              <Section
                title={`Pending candidates (${candidatesList().length})`}
                theme={theme()}
              >
                <For each={candidatesList()}>
                  {(c) => (
                    <MemoryRow
                      entry={c}
                      theme={theme()}
                      timeAgo={timeAgo}
                      onShow={showDetail}
                      onPromote={promote}
                      onReject={reject}
                      onForget={forget}
                    />
                  )}
                </For>
              </Section>
            </Show>
            <Show
              when={allActive().length > 0}
              fallback={
                <EmptyState
                  theme={theme()}
                  message="No memory entries"
                  hint="Memory is populated as agents work; it persists across sessions."
                />
              }
            >
              <For each={KIND_SECTIONS.filter((s) => grouped().get(s.key)?.length)}>
                {(section) => (
                  <Section
                    title={`${section.label} (${grouped().get(section.key)?.length ?? 0})`}
                    theme={theme()}
                  >
                    <For each={grouped().get(section.key) ?? []}>
                      {(entry) => (
                        <MemoryRow
                          entry={entry}
                          theme={theme()}
                          timeAgo={timeAgo}
                          onShow={showDetail}
                          onPromote={promote}
                          onReject={reject}
                          onForget={forget}
                        />
                      )}
                    </For>
                  </Section>
                )}
              </For>
            </Show>
          </Show>
        </box>
      </scrollbox>
    </box>
  )
}

function Section(props: { title: string; theme: any; children: any }) {
  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={toHex(props.theme.primary)}>
        <b>{props.title}</b>
      </text>
      <box flexDirection="column" marginTop={0}>{props.children}</box>
    </box>
  )
}

function SummaryPanel(props: { theme: any; summary: MemorySummary | null; loading: boolean }) {
  const kinds = () => {
    const items = props.summary?.byKind ?? []
    if (items.length === 0) return "no kinds"
    return items.map((s) => `${s.kind}=${s.count}`).join(", ")
  }
  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={toHex(props.theme.primary)}>
        <b>Summary</b>
      </text>
      <Show
        when={!props.loading && props.summary}
        fallback={
          <text fg={toHex(props.theme.textMuted)}>{props.loading ? "loading…" : "no summary"}</text>
        }
      >
        <box flexDirection="column" marginTop={0}>
          <text fg={toHex(props.theme.text)}>
            <b>{props.summary?.totalActive ?? 0}</b> active · {kinds()}
          </text>
          <Show when={(props.summary?.decisionDigest?.length ?? 0) > 0}>
            <text fg={toHex(props.theme.success)}>Decisions</text>
            <For each={(props.summary?.decisionDigest ?? []).slice(0, 3)}>
              {(d) => (
                <text fg={toHex(props.theme.textMuted)}>
                  {"  "}• [{d.kind}] {d.title}
                </text>
              )}
            </For>
          </Show>
          <Show when={(props.summary?.warningDigest?.length ?? 0) > 0}>
            <text fg={toHex(props.theme.warning)}>Warnings</text>
            <For each={(props.summary?.warningDigest ?? []).slice(0, 3)}>
              {(d) => (
                <text fg={toHex(props.theme.textMuted)}>
                  {"  "}• [{d.kind}] {d.title}
                </text>
              )}
            </For>
          </Show>
        </box>
      </Show>
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

function MemoryRow(props: {
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
    <box flexDirection="column" marginTop={0}>
      <box flexDirection="row" gap={2}>
        <text fg={toHex(props.theme[status().color])}>{status().glyph}</text>
        <text fg={toHex(props.theme.primary)} flexGrow={3} flexBasis={0} flexShrink={1} truncate>
          {props.entry.title ?? props.entry.key}
        </text>
        <text fg={toHex(props.theme.textMuted)} flexShrink={0}>
          v{props.entry.version}
        </text>
        <text fg={toHex(props.theme.textMuted)} flexShrink={0}>
          {props.timeAgo(props.entry.updatedAt)}
        </text>
      </box>
      <box flexDirection="row" gap={2} paddingLeft={3}>
        <text fg={toHex(props.theme.textMuted)} flexGrow={1} flexBasis={0} flexShrink={1} truncate>
          {previewBody(props.entry)}
        </text>
      </box>
      <box flexDirection="row" gap={2} paddingLeft={3} paddingBottom={0}>
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

export default plugin

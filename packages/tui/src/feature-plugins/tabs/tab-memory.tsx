/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, createResource, onCleanup, onMount, For, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { useDialog } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { DialogAlert } from "../../ui/dialog-alert"
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

function previewBody(e: MemoryEntry, max = 80): string {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim()
  if (e.body) {
    const body = normalize(e.body)
    return body.length > max ? body.slice(0, max - 1) + "…" : body
  }
  if (typeof e.value === "string") {
    const str = normalize(e.value)
    return str.length > max ? str.slice(0, max - 1) + "…" : str
  }
  if (e.value && typeof e.value === "object") {
    const json = normalize(JSON.stringify(e.value))
    return json.length > max ? json.slice(0, max - 1) + "…" : json
  }
  return ""
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const event = useEvent()
  const dialog = useDialog()
  const [refreshTrigger, setRefreshTrigger] = createSignal(0)

  const notify = (message: string) => {
    void props.api.attention.notify({ message, notification: false, sound: false })
  }

  // Single flat list: both scopes merged (the scope toggle was removed for
  // config-tab parity), all statuses included, newest first. The server only
  // filters by status/kind when those fields are present, so omitting them
  // returns pending candidates too — no separate candidates call needed.
  const [entries] = createResource(
    () => refreshTrigger(),
    async () => {
      try {
        const [globalRes, sessionRes] = await Promise.all([
          props.api.client.memory.list({
            banyanMemoryListInput: { scope: "global", limit: 100 },
          }),
          props.api.client.memory.list({
            banyanMemoryListInput: { scope: "session", limit: 100 },
          }),
        ])
        const all = [
          ...(((globalRes as any)?.data ?? []) as MemoryEntry[]),
          ...(((sessionRes as any)?.data ?? []) as MemoryEntry[]),
        ]
        const seen = new Set<string>()
        const merged: MemoryEntry[] = []
        for (const item of all) {
          if (!seen.has(item.id)) {
            seen.add(item.id)
            merged.push(item)
          }
        }
        return merged.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      } catch {
        return []
      }
    },
  )

  const list = () => entries() ?? []

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
        notify(errorMessage((result as any).error))
        return
      }
      notify(`Forgotten ${entry.key}`)
      setRefreshTrigger((n) => n + 1)
    } catch (e) {
      notify(errorMessage(e))
    }
  }

  const openAdd = () => {
    openAddMemoryDialog(props.api, dialog)
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
        <text fg={toHex(theme().primary)} onMouseUp={openAdd}>
          [+ Add memory]
        </text>
      </box>
      <text fg={toHex(theme().textMuted)} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        Cross-session memory. Click open to view details, forget to delete.
      </text>
      <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
        <box flexDirection="column" paddingTop={0} gap={0}>
          <Show when={entries() !== undefined} fallback={<LoadingState theme={theme()} />}>
            <Show
              when={list().length > 0}
              fallback={
                <EmptyState
                  theme={theme()}
                  message="No memory entries"
                  hint="Memory is populated as agents work; it persists across sessions."
                />
              }
            >
              <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={0}>
                <For each={list()}>
                  {(entry) => (
                    <MemoryCard
                      entry={entry}
                      theme={theme()}
                      timeAgo={timeAgo}
                      onShow={showDetail}
                      onForget={forget}
                    />
                  )}
                </For>
              </box>
            </Show>
          </Show>
        </box>
      </scrollbox>
    </box>
  )
}

function LoadingState(props: { theme: any }) {
  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={2} gap={0}>
      <box flexDirection="row" gap={2} alignItems="center">
        <text fg={toHex(props.theme.primary)}>◌</text>
        <text fg={toHex(props.theme.textMuted)}>Loading memory…</text>
      </box>
    </box>
  )
}

function EmptyState(props: { theme: any; message: string; hint: string }) {
  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={2} gap={0}>
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
  onForget: (e: MemoryEntry) => void | Promise<void>
}) {
  const status = () => statusGlyph(props.entry.status)
  const show = () => props.onShow(props.entry)
  return (
    <box
      flexDirection="column"
      border={["bottom"]}
      borderColor={props.theme.borderSubtle}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
    >
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={toHex(props.theme[status().color])}>{status().glyph}</text>
        <text fg={toHex(props.theme.primary)}>
          <b>{props.entry.kind ?? "observation"}:{props.entry.key}</b>
        </text>
        <text fg={toHex(props.theme.textMuted)}>v{props.entry.version}</text>
        <box flexGrow={1} justifyContent="flex-end" flexDirection="row">
          <text fg={toHex(props.theme.textMuted)}>{props.timeAgo(props.entry.updatedAt)}</text>
        </box>
      </box>
      <Show when={previewBody(props.entry)}>
        <text fg={toHex(props.theme.textMuted)} wrapMode="none" truncate>
          {previewBody(props.entry)}
        </text>
      </Show>
      <box flexDirection="row" gap={2} paddingTop={0}>
        <text fg={toHex(props.theme.info)} onMouseUp={show}>
          open
        </text>
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

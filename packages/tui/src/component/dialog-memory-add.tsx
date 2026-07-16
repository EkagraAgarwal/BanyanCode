/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { Show, createMemo, createSignal } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { errorMessage } from "../util/error"

const ALLOWED_KINDS = new Set([
  "preference",
  "identity",
  "convention",
  "decision",
  "architecture",
  "pattern",
  "warning",
  "failure",
  "todo",
  "observation",
  "summary",
  "ownership",
  "constraint",
  "environment",
])

export const MEMORY_KINDS: ReadonlyArray<string> = Array.from(ALLOWED_KINDS)

export const MEMORY_STATUSES: ReadonlyArray<string> = [
  "all",
  "active",
  "pending",
  "rejected",
  "superseded",
  "expired",
]

const KIND_DESCRIPTIONS: Record<string, string> = {
  preference: "User preference — how the agent should behave",
  identity: "Identity fact — who/what the project is",
  convention: "Coding or workflow convention",
  decision: "Decision with rationale",
  architecture: "Architectural choice or constraint",
  pattern: "Recurring pattern observed in the codebase",
  warning: "Warning the next session should heed",
  failure: "Failure mode to avoid repeating",
  todo: "Open task to track",
  observation: "Factual observation from the agent",
  summary: "Summary of a session or task",
  ownership: "Owner of a file / area / service",
  constraint: "Hard constraint (security, infra, policy)",
  environment: "Environment-specific fact",
}

const STATUS_DESCRIPTIONS: Record<string, string> = {
  all: "Show every entry regardless of status",
  active: "Entries currently used by the agent",
  pending: "Candidates awaiting review (promote/reject)",
  rejected: "Entries the user rejected",
  superseded: "Entries replaced by a newer version",
  expired: "Entries past their TTL",
}

export function DialogMemoryKind(props: { current?: string; onSelect?: (value: string) => void }) {
  const dialog = useDialog()
  const options = createMemo<DialogSelectOption<string>[]>(() => [
    { value: "all", title: "All kinds", description: KIND_DESCRIPTIONS.observation ? "Show every kind" : undefined },
    ...MEMORY_KINDS.map((k) => ({
      value: k,
      title: k,
      description: KIND_DESCRIPTIONS[k],
    })),
  ])
  return (
    <DialogSelect<string>
      title="Filter memory by kind"
      current={props.current ?? "all"}
      options={options()}
      onSelect={(option) => {
        props.onSelect?.(option.value)
        dialog.clear()
      }}
    />
  )
}

export function DialogMemoryStatus(props: { current?: string; onSelect?: (value: string) => void }) {
  const dialog = useDialog()
  const options = createMemo<DialogSelectOption<string>[]>(() =>
    MEMORY_STATUSES.map((s) => ({
      value: s,
      title: s,
      description: STATUS_DESCRIPTIONS[s],
    })),
  )
  return (
    <DialogSelect<string>
      title="Filter memory by status"
      current={props.current ?? "all"}
      options={options()}
      onSelect={(option) => {
        props.onSelect?.(option.value)
        dialog.clear()
      }}
    />
  )
}

const slugify = (title: string): string =>
  title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "memory"

const isUserMemoryKind = (raw: string): boolean => ALLOWED_KINDS.has(raw.trim())

export function openAddMemoryDialog(api: TuiPluginApi, dialog: ReturnType<typeof useDialog>) {
  void runFlow(api, dialog)
}

async function runFlow(api: TuiPluginApi, dialog: ReturnType<typeof useDialog>) {
  const title = await DialogPrompt.show(dialog, "Memory title", {
    placeholder: "Why we use Effect v4 over v3",
  })
  if (!title?.trim()) return
  const body = await DialogPrompt.show(dialog, "Memory body", {
    placeholder: "Short, durable rationale — what future-you would want to remember.",
    value: title.trim(),
  })
  if (!body?.trim()) return
  const kindRaw = await DialogPrompt.show(dialog, "Kind (decision/warning/preference/...)", {
    placeholder: "observation",
    value: "observation",
  })
  if (kindRaw === null) return
  const kind = isUserMemoryKind(kindRaw) ? kindRaw.trim() : "observation"

  const value = {
    kind,
    title: title.trim(),
    body: body.trim(),
    source: { type: "user" as const },
    confidence: "medium" as const,
    importance: "medium" as const,
    status: "pending" as const,
  }

  try {
    const result = await api.client.memory.store({
      banyanMemoryStoreInput: {
        key: slugify(title),
        scope: "global",
        value,
      },
    })
    if ((result as any)?.error) {
      showError(dialog, errorMessage((result as any).error))
      return
    }
    notify(api, `Queued "${title.trim()}" for orchestrator review`)
  } catch (err) {
    showError(dialog, errorMessage(err))
  }
}

function showError(dialog: ReturnType<typeof useDialog>, message: string) {
  dialog.replace(() => <DialogAlert title="Could not add memory" message={message} />)
}

function notify(api: TuiPluginApi, message: string) {
  void api.attention.notify({ message, notification: false, sound: false })
}

/**
 * Visual scaffold for the dialog flow (unused at runtime — `openAddMemoryDialog`
 * chains `DialogPrompt.show()` calls imperatively). Kept exported for tests
 * that want to render the placeholder component directly.
 */
export function DialogMemoryAddPlaceholder() {
  const dialog = useDialog()
  const [step, setStep] = createSignal<"title" | "body" | "kind">("title")
  return (
    <Show when={step() === "title"}>
      <DialogPrompt title="Memory title" onConfirm={() => setStep("body")} onCancel={() => dialog.clear()} />
    </Show>
  )
}
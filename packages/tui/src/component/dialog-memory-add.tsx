/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { Show, createSignal } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogAlert } from "../ui/dialog-alert"
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
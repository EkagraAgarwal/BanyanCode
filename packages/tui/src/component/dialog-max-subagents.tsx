/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DEFAULT_MAX_SUBAGENTS, MAX_SUBAGENTS_LIMIT } from "@opencode-ai/core/v1/config/banyan-config"

export function DialogMaxSubagents() {
  const dialog = useDialog()
  const toast = useToast()
  const sdk = useSDK()
  const sync = useSync()
  const [busy, setBusy] = createSignal(false)

  const initial = () => {
    const v = (sync.data.config as any).banyancode_max_subagents
    return typeof v === "number" && Number.isFinite(v) ? v : DEFAULT_MAX_SUBAGENTS
  }

  const submit = async (raw: string) => {
    const n = Number(raw)
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      toast.show({
        message: `Max subagents must be an integer; got "${raw}".`,
        variant: "error",
      })
      return
    }
    if (n < 1 || n > MAX_SUBAGENTS_LIMIT) {
      toast.show({
        message: `Max subagents must be between 1 and ${MAX_SUBAGENTS_LIMIT}.`,
        variant: "error",
      })
      return
    }
    setBusy(true)
    try {
      await (sdk.client as any).global.banyanConfig.update({
        config: { banyancode_max_subagents: n },
        scope: "global",
      })
      toast.show({ message: `Max subagents set to ${n}`, variant: "success" })
      dialog.clear()
    } catch (e) {
      toast.show({
        message: `Save failed: ${e instanceof Error ? e.message : String(e)}`,
        variant: "error",
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogPrompt
      title="Set max concurrent subagents (1-20)"
      value={String(initial())}
      busy={busy()}
      onConfirm={submit}
    />
  )
}

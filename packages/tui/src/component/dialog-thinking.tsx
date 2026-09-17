/** @jsxImportSource @opentui/solid */
import { createMemo, Show } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useData } from "../context/data"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { toHex } from "../util/color"
import { DEFAULT_THINKING_LEVEL, THINKING_LEVELS } from "@opencode-ai/core/v1/config/banyan-config"

const LEVEL_DESCRIPTIONS: Record<string, string> = {
  off: "No reasoning effort",
  low: "Fast, light reasoning",
  medium: "Balanced reasoning",
  high: "Deep reasoning",
  max: "Maximum reasoning",
  xhigh: "Extra-high reasoning",
  ultra: "Strongest available, falls back to max",
}

/** Pure builder so tests can assert filtering without rendering. */
export function thinkingLevelOptions(supported: string[] | undefined): DialogSelectOption<string>[] {
  return (THINKING_LEVELS as readonly string[]).map((level) => ({
    value: level,
    title: level === "off" ? "off" : level,
    description: LEVEL_DESCRIPTIONS[level] ?? "Reasoning level",
    // "off" always selects (it means omit); other levels are filtered to the
    // model's variant keys when known. DialogSelect hides disabled options.
    disabled: supported !== undefined && level !== "off" && !supported.includes(level),
  }))
}

export function DialogThinking(props: {
  model?: { providerID: string; modelID: string }
  current?: string
  preserveStack?: boolean
  onSelect?: (level: string) => void
}) {
  const data = useData()
  const dialog = useDialog()
  const { theme } = useTheme()

  // Variant keys of the agent's resolved model, via the catalog model list.
  // Unknown model (or models without variant metadata) yields undefined =
  // all levels enabled; the spawn path clamps to ProviderTransform keys.
  const supported = createMemo<string[] | undefined>(() => {
    if (!props.model) return undefined
    const info = data.location.model
      .list()
      ?.find((item) => item.providerID === props.model!.providerID && item.id === props.model!.modelID)
    if (!info) return undefined
    const ids = info.variants.map((variant) => variant.id)
    return ids.length > 0 ? ids : []
  })

  const options = createMemo(() => thinkingLevelOptions(supported()))

  const select = (level: string) => {
    props.onSelect?.(level)
    if (!props.preserveStack) dialog.clear()
  }

  return (
    <box flexDirection="column">
      <Show when={supported() !== undefined && supported()!.length === 0}>
        <box paddingLeft={4} paddingRight={4}>
          <text fg={toHex(theme.textMuted)}>No thinking levels for this model — only off applies.</text>
        </box>
      </Show>
      <DialogSelect<string>
        options={options().map((option) => ({
          ...option,
          onSelect: () => select(option.value),
        }))}
        title="Select thinking level"
        current={props.current ?? DEFAULT_THINKING_LEVEL}
        flat
      />
    </box>
  )
}

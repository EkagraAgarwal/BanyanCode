/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import { toHex } from "../util/color"

export type EmptyVariant = "loading" | "empty" | "error" | "info"

const GLYPH: Record<EmptyVariant, string> = {
  loading: "◌",
  empty: "∅",
  error: "✗",
  info: "○",
}

const COLOR: Record<EmptyVariant, "primary" | "textMuted" | "warning" | "error"> = {
  loading: "primary",
  empty: "textMuted",
  error: "error",
  info: "textMuted",
}

export function EmptyState(props: {
  variant?: EmptyVariant
  title: string
  hint?: string
  action?: string
  glyph?: string
}) {
  const { theme } = useTheme()
  const variant = () => props.variant ?? "empty"
  const glyphColor = () => {
    const c = COLOR[variant()]
    const color = (theme as unknown as Record<string, unknown>)[c]
    return typeof color === "string" ? toHex(color) : toHex(theme.textMuted)
  }
  const glyph = () => props.glyph ?? GLYPH[variant()]
  const titleColor = () =>
    variant() === "error" ? toHex(theme.error) : toHex(theme.text)
  const mutedColor = () => toHex(theme.textMuted)

  return (
    <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={2}>
      <box flexDirection="row" gap={2} alignItems="center">
        <text fg={glyphColor()}>{glyph()}</text>
        <text fg={titleColor()}>{props.title}</text>
      </box>
      <Show when={props.hint}>
        <box paddingLeft={4}>
          <text fg={mutedColor()} wrapMode="word">
            {props.hint}
          </text>
        </box>
      </Show>
      <Show when={props.action}>
        <box paddingLeft={4} paddingTop={1}>
          <text fg={mutedColor()}>{props.action}</text>
        </box>
      </Show>
    </box>
  )
}

/** @jsxImportSource @opentui/solid */
import { createMemo, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import type { JSX } from "@opentui/solid"

export interface MessageBlockProps {
  mode: "plan" | "diff" | "tool" | "report"
  label: string
  meta?: string
  hasPermissionLink?: boolean
  permissionRequestID?: string
  children: JSX.Element
  actions?: JSX.Element
  compact?: boolean
}

export function MessageBlock(props: MessageBlockProps) {
  const { theme } = useTheme()
  const sdk = useSDK()

  const labelColor = createMemo(() => {
    switch (props.mode) {
      case "plan": return theme.accent
      case "diff": return theme.success
      case "tool": return theme.borderSubtle
      case "report": return theme.borderSubtle
    }
  })

  const approve = () => {
    if (!props.permissionRequestID) return
    void sdk.client.permission.reply({
      requestID: props.permissionRequestID,
      reply: "once",
    })
  }

  const compact = () => Boolean(props.compact)
  const labelPadding = () => (compact() ? 1 : 2)

  return (
    <box marginTop={compact() ? 0 : 1}>
      <box
        backgroundColor={theme.backgroundPanel}
        width="100%"
        paddingTop={compact() ? 0 : 1}
        paddingBottom={compact() ? 0 : 1}
        paddingLeft={2}
        flexDirection="column"
        gap={compact() ? 0 : 1}
      >
        <box flexDirection="row" gap={1} alignItems="center">
          <text fg={labelColor()} paddingLeft={labelPadding()}>
            {props.label}
          </text>
          <Show when={props.meta}>
            <text fg={theme.textMuted}>·</text>
            <text fg={theme.textMuted}>{props.meta}</text>
          </Show>
        </box>
        {props.children}
        <Show
          when={props.mode === "diff" && props.hasPermissionLink && props.actions === undefined}
          fallback={
            <Show when={props.actions !== undefined}>{props.actions}</Show>
          }
        >
          <box flexDirection="row" gap={1} paddingLeft={2}>
            <text fg={theme.success} onMouseUp={approve}>[✓ approve]</text>
          </box>
        </Show>
      </box>
    </box>
  )
}

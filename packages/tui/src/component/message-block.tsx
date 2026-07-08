/** @jsxImportSource @opentui/solid */
import { createMemo, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useOpencodeKeymap } from "../keymap"
import type { JSX } from "@opentui/solid"

export interface MessageBlockProps {
  mode: "plan" | "diff" | "tool" | "report"
  label: string
  meta?: string
  hasPermissionLink?: boolean
  permissionRequestID?: string
  children: JSX.Element
  actions?: JSX.Element
}

export function MessageBlock(props: MessageBlockProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const keymap = useOpencodeKeymap()

  const borderColor = createMemo(() => {
    switch (props.mode) {
      case "plan": return theme.accent
      case "diff": return theme.success
      case "tool": return theme.warning
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

  const reject = () => {
    if (!props.permissionRequestID) return
    void sdk.client.permission.reply({
      requestID: props.permissionRequestID,
      reply: "reject",
    })
  }

  const viewDiff = () => {
    keymap.dispatchCommand("diff.toggle")
  }

  return (
    <box
      border={["left"]}
      borderColor={borderColor()}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      flexDirection="column"
      gap={1}
    >
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={borderColor()} paddingLeft={2}>
          {props.label}
        </text>
        <Show when={props.meta}>
          <text fg={theme.textMuted}>·</text>
          <text fg={theme.textMuted}>{props.meta}</text>
        </Show>
      </box>
      {props.children}
      <Show when={props.mode === "diff" && props.hasPermissionLink && props.actions === undefined}>
        <box flexDirection="row" gap={2} paddingLeft={2}>
          <text fg={theme.success} onMouseUp={approve}>[approve]</text>
          <text fg={theme.error} onMouseUp={reject}>[reject]</text>
          <text fg={theme.info} onMouseUp={viewDiff}>[view full diff]</text>
        </box>
      </Show>
      <Show when={props.mode === "diff" && !props.hasPermissionLink && props.actions === undefined}>
        <box flexDirection="row" gap={2} paddingLeft={2}>
          <text fg={theme.info} onMouseUp={viewDiff}>[view full diff]</text>
        </box>
      </Show>
      <Show when={props.actions !== undefined}>
        {props.actions}
      </Show>
    </box>
  )
}

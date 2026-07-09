/** @jsxImportSource @opentui/solid */
import { createMemo, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useOpencodeKeymap } from "../keymap"
import { RoundedBorder } from "../ui/border"
import { severityFill } from "../util/palette"
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
      customBorderChars={RoundedBorder.customBorderChars}
      border={["left", "right", "top", "bottom"]}
      borderColor={borderColor()}
      marginTop={1}
    >
      <box
        backgroundColor={theme.backgroundPanel}
        width="100%"
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
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
          <box
            customBorderChars={RoundedBorder.customBorderChars}
            border={["left", "right", "top", "bottom"]}
            borderColor={theme.success}
            flexShrink={0}
            onMouseUp={approve}
          >
            <box
              flexDirection="row"
              alignItems="center"
              gap={1}
              backgroundColor={severityFill(theme.backgroundPanel, theme.success, "success")}
              paddingLeft={1}
              paddingRight={1}
              width="100%"
              height="100%"
            >
              <text fg={theme.success}>✓</text>
              <text fg={theme.text}>approve</text>
            </box>
          </box>
          <box
            customBorderChars={RoundedBorder.customBorderChars}
            border={["left", "right", "top", "bottom"]}
            borderColor={theme.error}
            flexShrink={0}
            onMouseUp={reject}
          >
            <box
              flexDirection="row"
              alignItems="center"
              gap={1}
              backgroundColor={severityFill(theme.backgroundPanel, theme.error, "error")}
              paddingLeft={1}
              paddingRight={1}
              width="100%"
              height="100%"
            >
              <text fg={theme.error}>✕</text>
              <text fg={theme.text}>reject</text>
            </box>
          </box>
          <box
            customBorderChars={RoundedBorder.customBorderChars}
            border={["left", "right", "top", "bottom"]}
            borderColor={theme.info}
            flexShrink={0}
            onMouseUp={viewDiff}
          >
            <box
              flexDirection="row"
              alignItems="center"
              gap={1}
              backgroundColor={severityFill(theme.backgroundPanel, theme.info, "info")}
              paddingLeft={1}
              paddingRight={1}
              width="100%"
              height="100%"
            >
              <text fg={theme.info}>ⓘ</text>
              <text fg={theme.text}>view full diff</text>
            </box>
          </box>
        </box>
      </Show>
      <Show when={props.mode === "diff" && !props.hasPermissionLink && props.actions === undefined}>
        <box flexDirection="row" gap={2} paddingLeft={2}>
          <box
            customBorderChars={RoundedBorder.customBorderChars}
            border={["left", "right", "top", "bottom"]}
            borderColor={theme.info}
            flexShrink={0}
            onMouseUp={viewDiff}
          >
            <box
              flexDirection="row"
              alignItems="center"
              gap={1}
              backgroundColor={severityFill(theme.backgroundPanel, theme.info, "info")}
              paddingLeft={1}
              paddingRight={1}
              width="100%"
              height="100%"
            >
              <text fg={theme.info}>ⓘ</text>
              <text fg={theme.text}>view full diff</text>
            </box>
          </box>
        </box>
      </Show>
      <Show when={props.actions !== undefined}>
        {props.actions}
      </Show>
      </box>
    </box>
  )
}

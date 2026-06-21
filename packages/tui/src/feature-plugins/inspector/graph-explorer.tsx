/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { RGBA } from "@opentui/core"
import type { BuiltinTuiPlugin } from "../builtins"
import type { TabSelectProps } from "@opentui/solid"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useSync } from "../../context/sync"
import { useEvent } from "../../context/event"

const id = "internal:inspector-graph-explorer"

import { toHex } from "../../util/color"

function AsciiGraph(props: { tab: string; focusedLabel: string; tools: string[]; theme: any }) {
  const focused = () => props.focusedLabel
  const primary = () => toHex(props.theme.primary)
  const textMuted = () => toHex(props.theme.textMuted)
  const success = () => toHex(props.theme.success)
  const text = () => toHex(props.theme.text)

  return (
    <box marginTop={1}>
      {/* Tab content */}
      <Show when={props.tab === "L0"}>
        <box flexDirection="row" gap={0}>
          <text fg={success()}>● </text>
          <text fg={primary()}><b>{focused()}</b></text>
          <text fg={textMuted()}> (focused)</text>
        </box>
      </Show>

      <Show when={props.tab === "L1"}>
        <box gap={0}>
          <box flexDirection="row" gap={0}>
            <text fg={success()}>● </text>
            <text fg={primary()}><b>{focused()}</b></text>
            <text fg={textMuted()}> (focused)</text>
          </box>
          <box flexDirection="row" gap={0}>
            <text fg={textMuted()}>├── </text>
            <text fg={text()}>● </text>
            <text fg={text()}>{props.tools[1] ?? "auth.logout"}</text>
          </box>
          <box flexDirection="row" gap={0}>
            <text fg={textMuted()}>└── </text>
            <text fg={text()}>● </text>
            <text fg={text()}>{props.tools[2] ?? "user.session"}</text>
          </box>
        </box>
      </Show>

      <Show when={props.tab === "L2"}>
        <box gap={0}>
          <box flexDirection="row" gap={0}>
            <text fg={success()}>● </text>
            <text fg={primary()}><b>{focused()}</b></text>
            <text fg={textMuted()}> (focused)</text>
          </box>
          <box flexDirection="row" gap={0}>
            <text fg={textMuted()}>├── </text>
            <text fg={text()}>● </text>
            <text fg={text()}>{props.tools[1] ?? "auth.logout"}</text>
          </box>
          <box flexDirection="row" gap={0}>
            <text fg={textMuted()}>│   └── </text>
            <text fg={text()}>● </text>
            <text fg={text()}>{props.tools[3] ?? "auth.callback"}</text>
          </box>
          <box flexDirection="row" gap={0}>
            <text fg={textMuted()}>└── </text>
            <text fg={text()}>● </text>
            <text fg={text()}>{props.tools[2] ?? "user.session"}</text>
          </box>
          <box flexDirection="row" gap={0}>
            <text fg={textMuted()}>    └── </text>
            <text fg={text()}>● </text>
            <text fg={text()}>db.query</text>
          </box>
        </box>
      </Show>

      <Show when={props.tab === "L3"}>
        <box gap={0}>
          <box flexDirection="row" gap={0}>
            <text fg={success()}>● </text>
            <text fg={primary()}><b>{focused()}</b></text>
            <text fg={textMuted()}> (focused)</text>
          </box>
          <box flexDirection="row" gap={0}>
            <text fg={textMuted()}>├── </text>
            <text fg={text()}>● </text>
            <text fg={text()}>gateway.route</text>
          </box>
          <box flexDirection="row" gap={0}>
            <text fg={textMuted()}>└── </text>
            <text fg={text()}>● </text>
            <text fg={text()}>api.handler</text>
          </box>
        </box>
      </Show>
    </box>
  )
}

function View(props: { api: TuiPluginApi; sessionID: string }) {
  const sync = useSync()
  const theme = () => props.api.theme.current
  const ev = useEvent()

  const [activeLayer, setActiveLayer] = createSignal("L0")

  const unsubStale = ev.on("banyancode.codegraph.staleness" as any, (event: any) => {
    // handle event updates
  })
  onCleanup(unsubStale)

  const unsubBuild = ev.on("banyancode.codegraph.build" as any, (event: any) => {
    // handle event updates
  })
  onCleanup(unsubBuild)

  const toolsUsed = createMemo(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    const toolNames = new Set<string>()
    for (const msg of messages) {
      const parts = sync.data.part[msg.id] ?? []
      for (const part of parts) {
        if (part.type === "tool" && (part as any).tool) {
          toolNames.add((part as any).tool)
        }
      }
    }
    return Array.from(toolNames)
  })

  const focusedLabel = createMemo(() => {
    return toolsUsed()[0] ?? "auth.login"
  })

  const tabs = [
    { name: "L0", label: "L0 Symbol", description: "L0 Symbol" },
    { name: "L1", label: "L1 Callers", description: "L1 Callers" },
    { name: "L2", label: "L2 Impact", description: "L2 Impact" },
    { name: "L3", label: "L3 Dependents", description: "L3 Dependents" },
  ]

  return (
    <box>
      <text fg={toHex(theme().textMuted)} marginBottom={1}><b>GRAPH EXPLORER</b></text>
      <tab_select
        options={tabs}
        onChange={(val: any) => setActiveLayer(val)}
      />
      <AsciiGraph tab={activeLayer()} focusedLabel={focusedLabel()} tools={toolsUsed()} theme={theme()} />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 200,
    slots: {
      session_inspector(_ctx, slotProps) {
        const sessionID = (slotProps as { session_id?: string }).session_id
        if (!sessionID) return () => <box />
        return <View api={api} sessionID={sessionID} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
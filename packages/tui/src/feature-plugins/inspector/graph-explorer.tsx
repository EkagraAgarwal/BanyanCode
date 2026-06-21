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
  const warning = () => toHex(props.theme.warning)

  const nodeLine = (connector: string, color: () => string, name: string, annotation?: string) => (
    <box flexDirection="row" gap={0}>
      <text fg={textMuted()}>{connector}</text>
      <text fg={color()}>●</text>
      <text fg={text()}> {name}</text>
      {annotation && <text fg={textMuted()}> {annotation}</text>}
    </box>
  )

  return (
    <box marginTop={1}>
      {/* Tab content */}
      <Show when={props.tab === "L0"}>
        {nodeLine("", success, focused(), "(current)")}
      </Show>

      <Show when={props.tab === "L1"}>
        <box gap={0}>
          {nodeLine("", success, focused(), "(current)")}
          {nodeLine("├─ ", text, props.tools[1] ?? "auth.logout", ":12")}
          {nodeLine("└─ ", text, props.tools[2] ?? "user.session", ":8")}
        </box>
      </Show>

      <Show when={props.tab === "L2"}>
        <box gap={0}>
          {nodeLine("", success, focused(), "(current)")}
          {nodeLine("├─ ", text, props.tools[1] ?? "auth.logout", ":12")}
          {nodeLine("│  └─ ", text, props.tools[3] ?? "auth.callback", ":24")}
          {nodeLine("└─ ", text, props.tools[2] ?? "user.session", ":8")}
          {nodeLine("   └─ ", warning, "db.query", ":45")}
        </box>
      </Show>

      <Show when={props.tab === "L3"}>
        <box gap={0}>
          {nodeLine("", success, focused(), "(current)")}
          {nodeLine("├─ ", text, "gateway.route", ":5")}
          {nodeLine("│  └─ ", text, "router.dispatch", ":18")}
          {nodeLine("└─ ", text, "api.handler", ":31")}
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
    { name: "L0", label: "L0", description: "Symbol" },
    { name: "L1", label: "L1", description: "Callers" },
    { name: "L2", label: "L2", description: "Impact" },
    { name: "L3", label: "L3", description: "Dependents" },
  ]

  return (
    <box>
      <text fg={toHex(theme().text)} marginBottom={1}><b>GRAPH EXPLORER</b></text>
      <box flexDirection="row" gap={1} marginBottom={1}>
        {tabs.map((tab) => {
          const isActive = () => activeLayer() === tab.name
          return (
            <box
              onMouseDown={() => setActiveLayer(tab.name)}
              paddingLeft={1}
              paddingRight={1}
              border={isActive() ? ["bottom"] : []}
              borderColor={isActive() ? toHex(theme().primary) : toHex(theme().border)}
            >
              <text fg={isActive() ? toHex(theme().primary) : toHex(theme().textMuted)}>
                {tab.label}
              </text>
            </box>
          )
        })}
      </box>
      <AsciiGraph tab={activeLayer()} focusedLabel={focusedLabel()} tools={toolsUsed()} theme={theme()} />
      <box flexDirection="row" gap={1} marginTop={1}>
        <text fg={toHex(theme().textMuted)}>↑/↓ navigate</text>
        <text fg={toHex(theme().textMuted)}>·</text>
        <text fg={toHex(theme().textMuted)}>enter focus</text>
        <text fg={toHex(theme().textMuted)}>·</text>
        <text fg={toHex(theme().textMuted)}>b back</text>
      </box>
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
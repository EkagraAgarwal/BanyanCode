import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { activeTab, setActiveTab, type ActiveTab } from "./state"

const id = "internal:tabs-tab-bar"

const TABS: { key: ActiveTab; label: string }[] = [
  { key: "chat", label: "CHAT" },
  { key: "graph", label: "GRAPH" },
  { key: "memory", label: "MEMORY" },
  { key: "agents", label: "AGENTS" },
  { key: "settings", label: "SETTINGS" },
]

function toHex(color: { r: number; g: number; b: number; a?: number } | string): string {
  if (typeof color === "string") return color
  const norm = (v: number) => {
    const val = v <= 1 ? Math.round(v * 255) : Math.round(v)
    return Math.max(0, Math.min(255, val)).toString(16).padStart(2, "0")
  }
  const a = color.a !== undefined ? norm(color.a) : ""
  return `#${norm(color.r)}${norm(color.g)}${norm(color.b)}${a}`
}

function cycleTab(delta: 1 | -1) {
  const tabs = TABS.map((t) => t.key)
  const current = activeTab()
  const idx = tabs.indexOf(current)
  const next = (idx + delta + tabs.length) % tabs.length
  setActiveTab(tabs[next])
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  props.api.keymap.registerLayer({
    priority: 100,
    commands: [
      {
        name: "tabs.next",
        title: "Next tab",
        desc: "Switch to the next tab",
        category: "Tabs",
        run() {
          cycleTab(1)
        },
      },
      {
        name: "tabs.previous",
        title: "Previous tab",
        desc: "Switch to the previous tab",
        category: "Tabs",
        run() {
          cycleTab(-1)
        },
      },
    ],
    bindings: [
      { key: "ctrl+]", command: "tabs.next" },
      { key: "ctrl+[", command: "tabs.previous" },
    ],
  })

  return (
    <box flexDirection="row" flexShrink={0} gap={0}>
      {TABS.map((tab) => {
        const isActive = () => activeTab() === tab.key
        return (
          <box
            onMouseDown={() => setActiveTab(tab.key)}
            paddingLeft={2}
            paddingRight={2}
            border={isActive() ? ["bottom"] : []}
            borderColor={toHex(theme().primary)}
          >
            <text fg={isActive() ? toHex(theme().primary) : toHex(theme().textMuted)}>
              {tab.label}
            </text>
          </box>
        )
      })}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 10,
    slots: {
      session_main_tabs() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

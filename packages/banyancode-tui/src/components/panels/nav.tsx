import type { Context } from "@opencode/plugin/tui/context"
import { For } from "solid-js"
import { PANEL, type PanelName } from "../../constants"
import { palette } from "../../theme"

export type ViewKey = "chat" | "sessions" | "agents" | "config"

export const VIEW_TABS: ReadonlyArray<{
  readonly key: ViewKey
  readonly label: string
  readonly panel?: PanelName
}> = [
  { key: "chat", label: "CHAT" },
  { key: "sessions", label: "SESSIONS", panel: PANEL.sessions },
  { key: "agents", label: "AGENTS", panel: PANEL.agents },
  { key: "config", label: "CONFIG", panel: PANEL.config },
]

/** Which v1 tab is active for a panel name. */
export function viewKeyForPanel(name: string | undefined): ViewKey {
  if (name === PANEL.sessions) return "sessions"
  if (name === PANEL.agents) return "agents"
  if (name === PANEL.config) return "config"
  return "chat"
}

export function openView(
  context: Context,
  name: PanelName,
  // The v1 tabs replaced the transcript. Everything else opens beside the session.
  presentation: "panel" | "fullscreen" | "main" = VIEW_TABS.some((tab) => tab.panel === name) ? "main" : "panel",
) {
  const route = context.ui.router.current()
  const sessionID = route.type === "session" ? route.sessionID : undefined
  if (sessionID !== undefined && context.ui.panel.open(name, { presentation })) return
  context.ui.router.navigate({ type: "plugin", name, data: { view: name, sessionID } })
}

export function closeView(context: Context) {
  context.ui.panel.close()
  const route = context.ui.router.current()
  if (route.type !== "plugin") return
  const sessionID = typeof route.data?.sessionID === "string" ? route.data.sessionID : undefined
  if (sessionID !== undefined) {
    context.ui.router.navigate({ type: "session", sessionID })
    return
  }
  context.ui.router.navigate({ type: "home" })
}

export function selectView(context: Context, key: ViewKey) {
  if (key === "chat") {
    closeView(context)
    return
  }
  const tab = VIEW_TABS.find((item) => item.key === key)
  if (tab?.panel) openView(context, tab.panel)
}

/** v1 tab bar cycled CHAT → SESSIONS → AGENTS → CONFIG with ctrl+] / ctrl+[. */
export function cycleView(context: Context, delta: 1 | -1) {
  const route = context.ui.router.current()
  const current = viewKeyForPanel(
    context.ui.panel.current()?.name ?? (route.type === "plugin" ? route.name : undefined),
  )
  const index = VIEW_TABS.findIndex((tab) => tab.key === current)
  const next = VIEW_TABS[(index + delta + VIEW_TABS.length) % VIEW_TABS.length]!
  selectView(context, next.key)
}

/**
 * The v1 `session_main_tabs` row, expressed through v2's `session.panel`.
 * Rendered inside the BanyanCode panel (the panel is the v2 replacement for
 * the old full-screen tabs), and also on the router page.
 */
export function SessionTabs(props: {
  readonly context: Context
  readonly active: ViewKey
  readonly onSelect?: (key: ViewKey) => void
}) {
  const theme = () => palette(props.context.theme)
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      gap={0}
      justifyContent="center"
      paddingLeft={2}
      paddingRight={2}
      border={["bottom"]}
      borderColor={theme().border}
      width="100%"
    >
      <For each={VIEW_TABS}>
        {(tab) => (
          <box
            onMouseDown={() => (props.onSelect ? props.onSelect(tab.key) : selectView(props.context, tab.key))}
            paddingLeft={2}
            paddingRight={2}
            border={props.active === tab.key ? ["bottom"] : []}
            borderColor={theme().primary}
          >
            <text fg={props.active === tab.key ? theme().primary : theme().muted}>{tab.label}</text>
          </box>
        )}
      </For>
    </box>
  )
}

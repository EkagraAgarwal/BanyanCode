import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { PANEL, RAIL, type PanelName } from "../../constants"
import type { Live } from "../../data/live"
import { palette } from "../../theme"
import { AgentsPanel } from "../sidebar/agents"
import { CodegraphIntelPanel } from "../sidebar/codegraph-intel-panel"
import { IntelTracePanel } from "../sidebar/intel-trace-panel"
import { ProviderUsagePanel } from "../sidebar/provider-usage"
import { SystemPanel } from "../sidebar/system-status"
import { AgentDetails } from "../inspector/agent-details"
import { GraphExplorer } from "../inspector/graph-explorer"
import { PendingActions } from "../inspector/pending-actions"
import { TodoPanel } from "../inspector/todo"
import { AgentTreeView } from "./agents"
import { ConfigView } from "./config"
import { CodegraphCanvas } from "./graph"
import { createPanelFocus, PanelFocusContext, usePanelKeyMode, usePanelScroll } from "./keys"
import { SessionTabs, VIEW_TABS, viewKeyForPanel } from "./nav"
import { SessionsView } from "./sessions"

const RAIL_WIDTH = 13
const STACK_THRESHOLD = 72

function panelName(name: string): PanelName {
  return (Object.values(PANEL) as string[]).includes(name) ? (name as PanelName) : PANEL.details
}

/** Views with their own list scrollbox: the panel must not draw a second bar. */
export function panelScrollsInternally(name: PanelName): boolean {
  return name === PANEL.agents || name === PANEL.config || name === PANEL.sessions
}

function content(props: {
  readonly context: Context
  readonly live: Live
  readonly sessionID: string
  readonly active: PanelName
}) {
  const view = () => {
    const name = props.active
    if (name === PANEL.details) return <AgentDetails context={props.context} sessionID={props.sessionID} live={props.live} />
    if (name === PANEL.todos) return <TodoPanel context={props.context} sessionID={props.sessionID} />
    if (name === PANEL.graph) return <GraphExplorer context={props.context} codegraph={props.live.codegraph} />
    if (name === PANEL.canvas) return <CodegraphCanvas context={props.context} codegraph={props.live.codegraph} />
    if (name === PANEL.pending) return <PendingActions context={props.context} sessionID={props.sessionID} />
    if (name === PANEL.sessions) return <SessionsView context={props.context} />
    if (name === PANEL.agents) {
      return <AgentTreeView context={props.context} sessionID={props.sessionID} mesh={props.live.mesh} />
    }
    if (name === PANEL.config) return <ConfigView context={props.context} live={props.live} />
    if (name === PANEL.trace) {
      return <IntelTracePanel context={props.context} sessionID={props.sessionID} intel={props.live.intel} />
    }
    if (name === PANEL.usage) {
      return <ProviderUsagePanel context={props.context} sessionID={props.sessionID} usage={props.live.usage} />
    }
    if (name === PANEL.system) return <SystemPanel context={props.context} system={props.live.system} />
    return <AgentsPanel context={props.context} sessionID={props.sessionID} mesh={props.live.mesh} />
  }
  return view()
}

/**
 * Session-panel shell for every v1 left-rail view (inspector, tabs, graph
 * explorer). v2 owns the panel chrome, focus, and fullscreen toggle; this only
 * renders the rail and the selected view.
 */
export function InspectorPanel(props: {
  readonly context: Context
  readonly live: Live
  readonly panel: PanelInput
}) {
  const theme = () => palette(props.context.theme)
  const active = createMemo(() => panelName(props.panel.name))
  const innerScroll = createMemo(() => panelScrollsInternally(active()))
  const stacked = createMemo(() => props.panel.width < STACK_THRESHOLD)
  const focus = createPanelFocus(Math.max(0, RAIL.findIndex((item) => item.name === active())))
  const main = () => props.panel.presentation === "main"
  createEffect(() => {
    if (main()) focus.setZone("content")
  })
  let scroll: ScrollBoxRenderable | undefined

  const select = (name: PanelName) =>
    props.context.ui.panel.open(name, {
      presentation: VIEW_TABS.some((tab) => tab.panel === name) ? "main" : props.panel.presentation,
    })

  usePanelKeyMode(props.context, () => props.panel.focused)
  usePanelScroll(props.context, () => scroll)

  // Mouse selections move the rail cursor too, so the next arrow key starts
  // from the view the user is looking at.
  const syncRail = (name: PanelName) => focus.setRail(Math.max(0, RAIL.findIndex((item) => item.name === name)))
  createEffect(on(active, syncRail, { defer: true }))

  props.context.keymap.layer(() => ({
    mode: "banyancode.panel",
    priority: 30,
    commands: [
      {
        bind: "up",
        title: "Previous panel",
        group: "Panel",
        enabled: () => focus.zone() === "rail",
        run: () => focus.setRail((focus.rail() - 1 + RAIL.length) % RAIL.length),
      },
      {
        bind: "down",
        title: "Next panel",
        group: "Panel",
        enabled: () => focus.zone() === "rail",
        run: () => focus.setRail((focus.rail() + 1) % RAIL.length),
      },
      {
        bind: "enter",
        title: "Open panel",
        group: "Panel",
        enabled: () => focus.zone() === "rail",
        run: () => {
          const item = RAIL[focus.rail()]
          if (!item) return
          select(item.name)
          focus.setZone("content")
        },
      },
      {
        bind: "right",
        title: "Focus panel content",
        group: "Panel",
        enabled: () => focus.zone() === "rail",
        run: () => focus.setZone("content"),
      },
      {
        bind: "left",
        title: "Focus panel rail",
        group: "Panel",
        enabled: () => focus.zone() === "content" && !main(),
        run: () => focus.setZone("rail"),
      },
      {
        bind: "tab",
        title: "Switch panel region",
        group: "Panel",
        enabled: () => !main(),
        run: () => focus.setZone(focus.zone() === "rail" ? "content" : "rail"),
      },
      {
        bind: "f",
        title: "Toggle fullscreen",
        group: "Panel",
        enabled: () => !main(),
        run: () => props.panel.toggleFullscreen(),
      },
    ],
  }))

  const rail = (
    <box
      flexDirection={stacked() ? "row" : "column"}
      flexShrink={0}
      width={stacked() ? "100%" : RAIL_WIDTH}
      gap={stacked() ? 1 : 0}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={stacked() ? 0 : 1}
      border={stacked() ? ["bottom"] : ["right"]}
      borderColor={theme().border}
    >
      <For each={RAIL}>
        {(item, index) => (
          <text
            fg={active() === item.name ? theme().primary : index() === focus.rail() ? theme().text : theme().muted}
            onMouseUp={() => select(item.name)}
            wrapMode="none"
          >
            {index() === focus.rail() ? "› " : "  "}
            {item.label}
          </text>
        )}
      </For>
    </box>
  )

  const body = () => (
    <scrollbox
      id="banyancode.panel.content"
      ref={(element: ScrollBoxRenderable) => (scroll = element)}
      flexGrow={1}
      verticalScrollbarOptions={{ visible: !innerScroll(), paddingLeft: 1 }}
    >
      <box flexDirection="column" paddingTop={1}>
        {content({
          context: props.context,
          live: props.live,
          sessionID: props.panel.sessionID,
          active: active(),
        })}
      </box>
    </scrollbox>
  )

  if (main())
    return (
      <PanelFocusContext.Provider value={focus}>
        <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
          {body()}
        </box>
      </PanelFocusContext.Provider>
    )

  return (
    <PanelFocusContext.Provider value={focus}>
      <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
        <Show when={props.panel.presentation === "fullscreen"}>
          <SessionTabs context={props.context} active={viewKeyForPanel(active())} />
        </Show>
        <box flexDirection={stacked() ? "column" : "row"} flexGrow={1} minWidth={0} minHeight={0}>
          {rail}
          <box
            flexDirection="column"
            flexGrow={1}
            minWidth={0}
            minHeight={0}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
          >
            <box flexDirection="row" justifyContent="space-between" alignItems="center">
              <text fg={theme().muted}>{RAIL.find((item) => item.name === active())?.title ?? ""}</text>
              <box flexDirection="row" gap={2}>
                <Show when={props.panel.width >= STACK_THRESHOLD}>
                  <text fg={theme().faint}>{"↑↓ select · → action · enter · ← rail"}</text>
                </Show>
                <text fg={theme().muted} onMouseUp={props.panel.toggleFullscreen}>
                  {props.panel.presentation === "fullscreen" ? "f restore" : "f fullscreen"}
                </text>
                <text fg={theme().muted} onMouseUp={props.panel.close}>
                  esc close
                </text>
              </box>
            </box>
            {body()}
          </box>
        </box>
      </box>
    </PanelFocusContext.Provider>
  )
}

/** Router page: same views when no session panel is available (home route). */
export function InspectorPage(props: {
  readonly context: Context
  readonly live: Live
  readonly data?: Record<string, any>
}) {
  const theme = () => palette(props.context.theme)
  const sessionID = () => (typeof props.data?.sessionID === "string" ? props.data.sessionID : undefined)
  const [active, setActive] = createSignal<PanelName>(
    typeof props.data?.view === "string" ? panelName(props.data.view) : PANEL.details,
  )
  const focus = createPanelFocus(Math.max(0, RAIL.findIndex((item) => item.name === active())))
  const innerScroll = createMemo(() => panelScrollsInternally(active()))
  let scroll: ScrollBoxRenderable | undefined

  usePanelKeyMode(props.context, () => true)
  usePanelScroll(props.context, () => scroll)
  const syncRail = (name: PanelName) => focus.setRail(Math.max(0, RAIL.findIndex((item) => item.name === name)))
  createEffect(on(active, syncRail, { defer: true }))

  return (
    <PanelFocusContext.Provider value={focus}>
      <box flexDirection="column" flexGrow={1} minHeight={0}>
        <SessionTabs context={props.context} active={viewKeyForPanel(active())} />
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          border={["bottom"]}
          borderColor={theme().border}
        >
          <text fg={theme().text}>
            <b>BanyanCode</b>
          </text>
          <For each={RAIL}>
            {(item) => (
              <text
                fg={active() === item.name ? theme().primary : theme().muted}
                onMouseUp={() => setActive(item.name)}
              >
                {item.label}
              </text>
            )}
          </For>
        </box>
        <scrollbox
          id="banyancode.panel.page"
          ref={(element: ScrollBoxRenderable) => (scroll = element)}
          flexGrow={1}
          verticalScrollbarOptions={{ visible: !innerScroll(), paddingLeft: 1 }}
        >
          <box paddingLeft={2} paddingRight={2} paddingTop={1}>
            <Show
              when={sessionID()}
              fallback={
                <box flexDirection="column" gap={0}>
                  <text fg={theme().muted}>Open a session to use this view.</text>
                  <CodegraphIntelPanel context={props.context} intel={props.live.intel} />
                </box>
              }
            >
              {(id) => content({ context: props.context, live: props.live, sessionID: id(), active: active() })}
            </Show>
          </box>
        </scrollbox>
      </box>
    </PanelFocusContext.Provider>
  )
}

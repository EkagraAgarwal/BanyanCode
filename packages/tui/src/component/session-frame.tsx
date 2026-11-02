import {
  CliRenderEvents,
  RGBA,
  MouseEvent,
  type BoxRenderable,
  type Renderable,
  type ScrollBoxRenderable,
} from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { batch, createEffect, createMemo, createResource, createSignal, on, onCleanup, Show } from "solid-js"
import { Slot } from "../plugin/render"
import { CollapsedRail, SeparatorHandle } from "../ui/session-rails"
import { useConfig } from "../config"
import { useTheme } from "../context/theme"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"
import { InteractivityProvider } from "../context/interactivity"
import { useSessionTerminals } from "../context/session-terminals"
import { usePromptRef } from "../context/prompt"
import { usePanel } from "../context/panel"
import { useStorage } from "../context/storage"
import { useDialog } from "../ui/dialog"
import { Session } from "../routes/session"
import { Sidebar } from "../routes/session/sidebar"
import { clampSessionPaneWidth } from "../ui/layout"
import { createPaneResize } from "../ui/pane-resize"
import { PaneResizeHandle } from "../ui/pane-resize-handle"
import { useToast } from "../ui/toast"
import { TerminalPane } from "./terminal-pane"
import { PanelHost } from "./panel-host"

const DEFAULT_SIDE_PERCENT = 22
const SIDE_MIN_PERCENT = 18
const SIDEBAR_MAX_PERCENT = 38
const INSPECTOR_MAX_PERCENT = 34
const SIDE_COLLAPSE_PERCENT = 15
const SESSION_MIN_WIDTH_BESIDE_PANE = 44

export function SessionFrame(props: { sessionID: string; verticalTabsWidth: number }) {
  const sessions = useSessionTerminals()
  const prompt = usePromptRef()
  const config = useConfig()
  const data = useData()
  const toast = useToast()
  const terminalError = () => toast.show({ variant: "error", message: "Unable to load terminal" })
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const panels = usePanel()
  const dialog = useDialog()
  const theme = useTheme()
  const availableWidth = () => Math.max(0, dimensions().width - props.verticalTabsWidth)
  const defaultPaneWidth = () => Math.max(1, Math.floor(panels.width() / 2))
  const [layout, updateLayout] = useStorage().store<{
    paneWidth?: number
    terminalWidth?: number
    sidebarPercent?: number
    inspectorPercent?: number
    inspectorHidden?: boolean
  }>("layout", {
    initial: {},
  })
  const paneResize = createPaneResize({
    value: () => layout.paneWidth ?? layout.terminalWidth ?? defaultPaneWidth(),
    defaultValue: defaultPaneWidth,
    clamp: (width) => clampSessionPaneWidth(width, panels.width()),
    fromMouse: (event) => dimensions().width - event.x - 1,
    contains: (event, width) => event.x >= dimensions().width - width - 1 && event.x <= dimensions().width - width,
    onCommit: (width) => {
      void updateLayout((draft) => {
        draft.paneWidth = width
      }).catch((error) => console.error("Failed to persist TUI layout", error))
    },
  })
  let resizeRelease = false
  const finishPaneResize = (event: MouseEvent) => {
    if (paneResize.resizing()) {
      // A captured drag-end can be followed by mouse-up on the focus overlay.
      resizeRelease = true
      queueMicrotask(() => {
        resizeRelease = false
      })
    }
    paneResize.onMouseUp(event)
  }
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [sessionWidth, setSessionWidth] = createSignal<number>()
  const [activePane, setActivePane] = createSignal<"session" | "right">("session")
  const [restoreTerminalFocus, setRestoreTerminalFocus] = createSignal(false)
  let focusTerminal: (() => void) | undefined
  let showTerminals: (() => void) | undefined
  let sessionScroll: ScrollBoxRenderable | undefined
  let sessionNode: BoxRenderable | undefined
  let rightNode: BoxRenderable | undefined
  let panelNode: BoxRenderable | undefined
  createResource(
    () => (sessions.available() ? props.sessionID : undefined),
    (sessionID) => sessions.refresh(sessionID).catch(() => undefined),
  )
  const session = () => sessions.get(props.sessionID)
  const selectedTerminal = () => {
    if (!sessions.available()) return
    const value = session()
    return value.terminals.find((terminal) => terminal.id === value.selectedTerminalID)
  }
  const activePanel = createMemo(() => {
    const current = panels.current()
    if (current?.sessionID === props.sessionID) return current
  })
  const fullscreen = () => activePanel() !== undefined && panels.presentation() === "fullscreen"
  // A small terminal needs every row for the transcript and composer.
  const chrome = () => !fullscreen() && dimensions().height >= 20 && dimensions().width >= 60
  const mainPanel = createMemo(() => (panels.presentation() === "main" ? activePanel() : undefined))
  createEffect(
    on([activePanel, () => selectedTerminal()?.id], ([panel, terminal], previous) => {
      if (panel && panel !== previous?.[0]) {
        if (!wide()) setSidebarOpen(false)
        if (terminal) void sessions.selectTerminal(props.sessionID, null).catch(toast.error)
        return
      }
      if (terminal && terminal !== previous?.[1]) {
        if (!wide()) setSidebarOpen(false)
        if (panel) panels.close()
      }
    }),
  )
  const wide = createMemo(() => dimensions().width - props.verticalTabsWidth > 120)
  const sidebarVisible = createMemo(() => {
    if (data.session.get(props.sessionID)?.parentID) return false
    if (sidebarOpen()) return true
    return (config.data.session?.sidebar ?? "auto") === "auto" && wide()
  })
  // Wide terminals dock the sidebar on the left, so only a narrow one still opens it over the session.
  const rightPane = createMemo(() => {
    if (activePanel() && !mainPanel()) return "panel"
    if (!wide() && sidebarVisible()) return "sidebar"
    if (selectedTerminal()) return "terminal"
    if (wide() && !layout.inspectorHidden && !data.session.get(props.sessionID)?.parentID) return "inspector"
  })
  const sidebarPercent = () => layout.sidebarPercent ?? DEFAULT_SIDE_PERCENT
  const inspectorPercent = () => layout.inspectorPercent ?? DEFAULT_SIDE_PERCENT
  const sideWidth = (percent: number) => Math.round((percent / 100) * availableWidth())
  const rightWidth = () =>
    rightPane() === "inspector" ? sideWidth(inspectorPercent()) : rightPane() ? paneResize.size() : 0
  // A terminal or panel on the right can leave too little room for the session beside the sidebar too.
  const sidebarDocked = createMemo(
    () =>
      wide() &&
      sidebarVisible() &&
      !fullscreen() &&
      availableWidth() - sideWidth(sidebarPercent()) - rightWidth() >= SESSION_MIN_WIDTH_BESIDE_PANE,
  )
  const persistLayout = (change: (draft: typeof layout) => void) =>
    void updateLayout(change).catch((error) => console.error("Failed to persist TUI layout", error))
  const resizeSide = (key: "sidebarPercent" | "inspectorPercent", max: number) => (percent: number) => {
    if (percent < SIDE_COLLAPSE_PERCENT) {
      if (key === "sidebarPercent") toggleSidebar()
      else persistLayout((draft) => void (draft.inspectorHidden = true))
      return
    }
    persistLayout((draft) => void (draft[key] = Math.max(SIDE_MIN_PERCENT, Math.min(max, percent))))
  }
  const toggleSidebar = () => {
    batch(() => {
      const visible = sidebarVisible()
      void config
        .update((draft) => {
          draft.session = { ...draft.session, sidebar: visible ? "hide" : "auto" }
        })
        .catch(toast.error)
      setSidebarOpen(!visible)
      if (!visible && !wide() && activePanel()) panels.close()
      if (!visible && !wide() && selectedTerminal())
        void sessions.selectTerminal(props.sessionID, null).catch(toast.error)
    })
  }
  const focusSession = () => {
    if (fullscreen()) return
    // Permission prompts replace the input, so returning focus must not depend on it.
    if (activePane() === "right") renderer.currentFocusedRenderable?.blur()
    setActivePane("session")
    prompt.current?.focus()
  }
  const focusRightPane = () => {
    setActivePane("right")
    if (activePanel()) {
      panelNode?.focus()
      return
    }
    focusTerminal?.()
  }
  const onFocused = () => {
    const current = renderer.currentFocusedRenderable
    if ((rightPane() === "terminal" || rightPane() === "panel") && within(current, rightNode)) setActivePane("right")
    if (!fullscreen() && within(current, sessionNode) && !within(current, panelNode)) setActivePane("session")
    if (mainPanel() && within(current, panelNode)) setActivePane("right")
  }
  renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, onFocused)
  onCleanup(() => renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, onFocused))
  createEffect(() => {
    if (fullscreen()) focusRightPane()
  })
  createEffect(() => {
    if (rightPane() !== "terminal" && rightPane() !== "panel" && !mainPanel()) setActivePane("session")
  })
  createEffect(() => {
    if (!restoreTerminalFocus() || selectedTerminal()) return
    setRestoreTerminalFocus(false)
    focusSession()
  })
  Keymap.createLayer(() => ({
    mode: "global",
    enabled: () => (rightPane() === "terminal" || activePanel() !== undefined) && dialog.stack.length === 0,
    commands: [
      {
        id: "pane.focus.left",
        title: "Focus session pane",
        enabled: () => !fullscreen(),
        run: focusSession,
      },
      {
        id: "pane.focus.right",
        title: "Focus right pane",
        run: focusRightPane,
      },
    ],
  }))

  // Pane management stays reachable from either input scope.
  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      {
        id: "session.sidebar.toggle",
        title: sidebarVisible() ? "Hide sidebar" : "Show sidebar",
        group: "Session",
        palette: true,
        run: () => {
          toggleSidebar()
          dialog.clear()
        },
      },
      {
        id: "session.inspector.toggle",
        title: layout.inspectorHidden ? "Show inspector" : "Hide inspector",
        group: "Session",
        palette: true,
        run: () => {
          persistLayout((draft) => void (draft.inspectorHidden = !draft.inspectorHidden))
          dialog.clear()
        },
      },
      ...(sessions.available()
        ? [
            {
              id: "terminal.toggle",
              title: rightPane() === "terminal" ? "Hide terminal pane" : "Show terminal pane",
              group: "Session",
              palette: true as const,
              run: () => {
                dialog.clear()
                if (rightPane() === "terminal") {
                  focusSession()
                  void sessions.selectTerminal(props.sessionID, null).catch(toast.error)
                  return
                }
                void sessions
                  .refresh(props.sessionID)
                  .then(async () => {
                    const terminal = sessions.get(props.sessionID).terminals.at(-1)
                    if (terminal) return sessions.selectTerminal(props.sessionID, terminal.id)
                    await sessions.newTerminal(props.sessionID)
                  })
                  .catch(terminalError)
              },
            },
            {
              id: "terminal.select",
              title: "Select terminal",
              group: "Session",
              palette: true as const,
              run: () => {
                dialog.clear()
                if (fullscreen()) panels.close()
                focusSession()
                showTerminals?.()
                void sessions.refresh(props.sessionID).catch(terminalError)
              },
            },
            {
              id: "terminal.close",
              title: "Close terminal pane",
              group: "Session",
              palette: true as const,
              enabled: rightPane() === "terminal",
              run: () => {
                dialog.clear()
                focusSession()
                void sessions.selectTerminal(props.sessionID, null).catch(toast.error)
              },
            },
            {
              id: "session.terminal",
              title: "New terminal",
              group: "Session",
              palette: true as const,
              slash: { name: "terminal" },
              run: async () => {
                dialog.clear()
                await sessions.newTerminal(props.sessionID).catch(terminalError)
              },
            },
          ]
        : []),
    ],
  }))

  return (
    <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column">
    <Show when={chrome()}>
      <Slot path="session.header" input={{ sessionID: props.sessionID }} />
    </Show>
    <box
      flexGrow={1}
      minWidth={0}
      minHeight={0}
      flexDirection="row"
      position="relative"
      onMouseDrag={paneResize.onMouseDrag}
      onMouseDragEnd={finishPaneResize}
      onMouseUp={finishPaneResize}
    >
      <Show when={sidebarDocked()}>
        <box flexShrink={0} width={sideWidth(sidebarPercent())} minHeight={0}>
          <Sidebar sessionID={props.sessionID} width={sideWidth(sidebarPercent())} />
        </box>
        <SeparatorHandle
          side="left"
          percent={sidebarPercent}
          onResize={resizeSide("sidebarPercent", SIDEBAR_MAX_PERCENT)}
        />
      </Show>
      <Show when={wide() && !sidebarVisible() && !fullscreen() && !data.session.get(props.sessionID)?.parentID}>
        <CollapsedRail side="left" onExpand={toggleSidebar} />
      </Show>
      <box
        id="session-pane"
        ref={(value: BoxRenderable) => (sessionNode = value)}
        flexGrow={1}
        flexBasis={0}
        minWidth={0}
        minHeight={0}
        position={fullscreen() ? "absolute" : "relative"}
        visible={!fullscreen()}
        width={fullscreen() ? Math.max(0, panels.width() - paneResize.size()) : undefined}
        height="100%"
        onSizeChange={function () {
          setSessionWidth(this.width)
        }}
      >
        <InteractivityProvider enabled={(activePane() === "session" || mainPanel() !== undefined) && !fullscreen()}>
          <Session
            scrollRef={(value) => (sessionScroll = value)}
            verticalTabsWidth={props.verticalTabsWidth}
            promptMuted={activePane() !== "session"}
            sidebarVisible={rightPane() === "sidebar"}
            onToggleSidebar={toggleSidebar}
            terminals={sessions.available()}
            visibleTerminalID={rightPane() === "terminal" ? selectedTerminal()?.id : undefined}
            onTerminalPicker={(show) => (showTerminals = show)}
            width={sessionWidth()}
            main={
              <Show keyed when={mainPanel()}>
                {(item) => (
                  <box position="absolute" left={0} top={0} width="100%" height="100%" zIndex={2}>
                    <PanelHost
                      panel={item}
                      width={Math.max(0, (sessionWidth() ?? availableWidth()) - 4)}
                      focused={activePane() === "right"}
                      onFocus={focusRightPane}
                      onTarget={(node) => {
                        panelNode = node
                        if (node) {
                          focusRightPane()
                          return
                        }
                        focusSession()
                      }}
                    />
                  </box>
                )}
              </Show>
            }
          />
        </InteractivityProvider>
        <Show when={activePane() === "right" && !mainPanel()}>
          <box
            position="absolute"
            left={0}
            top={0}
            width="100%"
            height="100%"
            zIndex={1}
            onMouseScroll={(event) => {
              if (!sessionScroll || sessionScroll.isDestroyed) return
              const viewport = sessionScroll.viewport
              if (event.x < viewport.x || event.x >= viewport.x + viewport.width) return
              if (event.y < viewport.y || event.y >= viewport.y + viewport.height) return
              // Keep the focus-only click guard, but let the transcript handle its own wheel events.
              event.stopPropagation()
              sessionScroll.processMouseEvent(new MouseEvent(sessionScroll, event))
            }}
            // Consume the release before revealing permission buttons underneath.
            onMouseUp={() => {
              if (paneResize.resizing() || resizeRelease) return
              focusSession()
            }}
          />
        </Show>
      </box>
      <Show when={rightPane() === "inspector" && !fullscreen()}>
        <SeparatorHandle
          side="right"
          percent={inspectorPercent}
          onResize={resizeSide("inspectorPercent", INSPECTOR_MAX_PERCENT)}
        />
        <box
          flexShrink={0}
          width={sideWidth(inspectorPercent())}
          minHeight={0}
          border
          borderStyle="rounded"
          borderColor={theme.border.base}
          backgroundColor={theme.background.raised.base}
          paddingLeft={1}
          paddingRight={1}
        >
          <scrollbox flexGrow={1} minHeight={0} horizontalScrollbarOptions={{ visible: false }}>
            <box flexDirection="column" flexShrink={0} gap={1} paddingRight={1}>
              <Slot path="session.inspector" input={{ sessionID: props.sessionID }} />
            </box>
          </scrollbox>
        </box>
      </Show>
      <Show when={wide() && layout.inspectorHidden && !rightPane() && !data.session.get(props.sessionID)?.parentID}>
        <CollapsedRail
          side="right"
          onExpand={() => persistLayout((draft) => void (draft.inspectorHidden = false))}
        />
      </Show>
      <Show when={rightPane() === "terminal" || rightPane() === "panel"}>
        <box
          ref={(value: BoxRenderable) => (rightNode = value)}
          flexShrink={0}
          width={fullscreen() ? availableWidth() : paneResize.size()}
          minWidth={0}
          minHeight={0}
        >
              <Show
                keyed
                when={activePanel()}
                fallback={
                  <Show keyed when={selectedTerminal()?.id}>
                    {(ptyID) => (
                      <TerminalPane
                        ptyID={ptyID}
                        resizing={paneResize.resizing()}
                        autoFocus={restoreTerminalFocus() || sessions.shouldFocus(ptyID)}
                        onAutoFocus={() => {
                          sessions.clearFocus(ptyID)
                          setRestoreTerminalFocus(false)
                        }}
                        onFocusRequest={(value) => (focusTerminal = value)}
                        onDisconnect={() => setRestoreTerminalFocus(true)}
                      />
                    )}
                  </Show>
                }
              >
                {(item) => (
                  <PanelHost
                    panel={item}
                    width={fullscreen() ? availableWidth() : paneResize.size()}
                    focused={activePane() === "right"}
                    onFocus={focusRightPane}
                    onTarget={(node) => {
                      panelNode = node
                      if (node) {
                        focusRightPane()
                        return
                      }
                      setActivePane("session")
                    }}
                  />
                )}
              </Show>
        </box>
      </Show>
      <Show when={!fullscreen() && (rightPane() === "terminal" || rightPane() === "panel") && availableWidth() >= 3}>
        <PaneResizeHandle resize={paneResize} left={availableWidth() - paneResize.size() - 1} highlight="right" />
      </Show>
      <Show when={rightPane() === "sidebar" && !wide()}>
        <box
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          alignItems="flex-end"
          backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
        >
          <Sidebar sessionID={props.sessionID} />
        </box>
      </Show>
    </box>
    <Show when={chrome()}>
      <Slot path="session.footer" input={{ sessionID: props.sessionID }} />
    </Show>
    </box>
  )
}

function within(node: Renderable | null | undefined, root: Renderable | undefined) {
  if (!root) return false
  for (let current = node; current; current = current.parent) {
    if (current === root) return true
  }
  return false
}

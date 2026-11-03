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
import { TRUNK_RAIL_MIN_WIDTH } from "@banyancode/tui/trunk"
import { Slot } from "../plugin/render"
import { CollapsedRail, SeparatorHandle } from "../ui/session-rails"
import { useConfig } from "../config"
import { useTheme } from "../context/theme"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"
import { InteractivityProvider } from "../context/interactivity"
import { useSessionTerminals } from "../context/session-terminals"
import { usePromptRef } from "../context/prompt"
import { usePanel, panelEaseOut, panelSpring } from "../context/panel"
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
/** The Trunk layout caps the transcript at this many columns, and docks its rail beside it. */
const TRUNK_TRANSCRIPT_WIDTH = 96
const TRUNK_PANE_PADDING = 4
/** The panels overlay's width, and its spring / ease-out durations. */
const PANEL_OVERLAY_WIDTH = 44
const PANEL_OPEN_MS = 700
const PANEL_CLOSE_MS = 500
/** The overlay's clock frame, matching the trunk's 12 fps ceiling. */
const PANEL_FRAME_MS = 1000 / 12

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
  // Classic is the default chat layout; `session_layout: "trunk"` grows subagents on a rail instead.
  const trunk = () => config.data.session_layout === "trunk"
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
  const railWidth = () => dimensions().width - props.verticalTabsWidth
  const sidebarVisible = createMemo(() => {
    if (data.session.get(props.sessionID)?.parentID) return false
    if (sidebarOpen()) return true
    return (config.data.session?.sidebar ?? "auto") === "auto" && wide()
  })
  // The Trunk rail replaces the sidebar: it docks from the same threshold, but
  // it survives narrower terminals because a branch label needs fewer columns
  // than the eight side panels did.
  const trunkRailVisible = createMemo(() => {
    if (!trunk()) return false
    if (data.session.get(props.sessionID)?.parentID) return false
    if (railWidth() < TRUNK_RAIL_MIN_WIDTH) return false
    if (sidebarOpen()) return true
    return (config.data.session?.sidebar ?? "auto") === "auto"
  })
  // Wide terminals dock the sidebar on the left, so only a narrow one still opens it over the session.
  const rightPane = createMemo(() => {
    if (activePanel() && !mainPanel()) return "panel"
    if (!trunk() && !wide() && sidebarVisible()) return "sidebar"
    if (selectedTerminal()) return "terminal"
    if (!trunk() && wide() && !layout.inspectorHidden && !data.session.get(props.sessionID)?.parentID) return "inspector"
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
  /** What occupies the left column: the trunk rail, or the classic docked sidebar. */
  const leftDocked = createMemo(() => (trunk() ? trunkRailVisible() : sidebarDocked()))
  // The Trunk overlay keeps the transcript at its own width: it slides over the
  // right edge instead of taking a column, so nothing reflows underneath it.
  const overlayWidth = createOverlayWidth({
    open: () => trunk() && panels.overlay(),
    animations: () => config.data.animations ?? true,
    width: PANEL_OVERLAY_WIDTH,
  })
  const persistLayout = (change: (draft: typeof layout) => void) =>
    void updateLayout(change).catch((error) => console.error("Failed to persist TUI layout", error))
  const hideSidebar = () => {
    batch(() => {
      void config
        .update((draft) => {
          draft.session = { ...draft.session, sidebar: "hide" }
        })
        .catch(toast.error)
      setSidebarOpen(false)
    })
  }
  const resizeSide = (key: "sidebarPercent" | "inspectorPercent", max: number) => (percent: number) => {
    if (percent < SIDE_COLLAPSE_PERCENT) {
      // Dragging the rail shut hides the column rather than opening the panel
      // overlay, which is what the same gesture used to do to the sidebar.
      if (key === "sidebarPercent") {
        if (trunk()) hideSidebar()
        else toggleSidebar()
      } else persistLayout((draft) => void (draft.inspectorHidden = true))
      return
    }
    persistLayout((draft) => void (draft[key] = Math.max(SIDE_MIN_PERCENT, Math.min(max, percent))))
  }
  const toggleSidebar = () => {
    // In the Trunk layout the side panels only exist as an overlay, so the same
    // key slides them in and out without reflowing the transcript.
    if (trunk()) {
      panels.toggleOverlay()
      return
    }
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
        title: trunk()
          ? panels.overlay()
            ? "Hide panels"
            : "Show panels"
          : sidebarVisible()
            ? "Hide sidebar"
            : "Show sidebar",
        group: "Session",
        palette: true,
        run: () => {
          toggleSidebar()
          dialog.clear()
        },
      },
      {
        // The panels overlay closes the way it opens, and with escape.
        id: "session.panels.close",
        title: "Close panels",
        group: "Session",
        bind: "escape",
        enabled: () => trunk() && panels.overlay() && dialog.stack.length === 0,
        run: () => {
          panels.closeOverlay()
        },
      },
      {
        id: "session.inspector.toggle",
        title: layout.inspectorHidden ? "Show inspector" : "Hide inspector",
        group: "Session",
        palette: true,
        // Trunk has no right inspector: its panels live in the overlay instead.
        enabled: () => !trunk(),
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
      <Show when={leftDocked()}>
        <box flexShrink={0} width={sideWidth(sidebarPercent())} minHeight={0}>
          <Show
            when={trunk()}
            fallback={<Sidebar sessionID={props.sessionID} width={sideWidth(sidebarPercent())} />}
          >
            <Slot
              path="session.rail"
              input={{ sessionID: props.sessionID, width: sideWidth(sidebarPercent()) }}
            >
              <Sidebar sessionID={props.sessionID} width={sideWidth(sidebarPercent())} />
            </Slot>
          </Show>
        </box>
        <SeparatorHandle
          side="left"
          percent={sidebarPercent}
          onResize={resizeSide("sidebarPercent", SIDEBAR_MAX_PERCENT)}
        />
      </Show>
      <Show
        when={
          !trunk() && wide() && !sidebarVisible() && !fullscreen() && !data.session.get(props.sessionID)?.parentID
        }
      >
        <CollapsedRail side="left" onExpand={toggleSidebar} />
      </Show>
      <box
        id="session-pane"
        ref={(value: BoxRenderable) => (sessionNode = value)}
        flexGrow={1}
        flexBasis={0}
        minWidth={0}
        minHeight={0}
        maxWidth={trunk() && !mainPanel() ? TRUNK_TRANSCRIPT_WIDTH + TRUNK_PANE_PADDING : undefined}
        position={fullscreen() ? "absolute" : "relative"}
        visible={!fullscreen()}
        width={fullscreen() ? Math.max(0, panels.width() - paneResize.size()) : undefined}
        height="100%"
        onSizeChange={function () {
          setSessionWidth(this.width)
        }}
        // A tab keeps the composer usable: a click outside the tab's own area gives it the keyboard.
        onMouseUp={(event) => {
          if (!mainPanel() || activePane() !== "right" || !panelNode) return
          const inside =
            event.x >= panelNode.x &&
            event.x < panelNode.x + panelNode.width &&
            event.y >= panelNode.y &&
            event.y < panelNode.y + panelNode.height
          if (!inside) focusSession()
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
      <Show
        when={
          !trunk() && wide() && layout.inspectorHidden && !rightPane() && !data.session.get(props.sessionID)?.parentID
        }
      >
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
      <Show when={trunk() && overlayWidth() > 0.5 && !fullscreen()}>
        <box
          id="session-panels-overlay"
          position="absolute"
          top={0}
          right={0}
          bottom={0}
          width={Math.max(1, Math.round(overlayWidth()))}
          zIndex={5}
          backgroundColor={theme.background.raised.base}
        >
          <Sidebar sessionID={props.sessionID} width={Math.max(1, Math.round(overlayWidth()))} />
        </box>
      </Show>
    </box>
    <Show when={chrome()}>
      <Slot path="session.footer" input={{ sessionID: props.sessionID }} />
    </Show>
    </box>
  )
}

/**
 * The panels overlay's width over time: a 700 ms spring opening, a 500 ms
 * ease-out closing. The interval exists only while the width is changing and is
 * cleared on unmount, so a settled overlay holds no timer. With animations off
 * the width jumps to its target.
 */
function createOverlayWidth(options: {
  readonly open: () => boolean
  readonly animations: () => boolean
  readonly width: number
}): () => number {
  const [value, setValue] = createSignal(0)
  let handle: ReturnType<typeof setInterval> | undefined
  let from = 0
  let to = 0
  const stop = () => {
    if (handle === undefined) return
    clearInterval(handle)
    handle = undefined
  }
  onCleanup(stop)
  createEffect(
    on(
      options.open,
      (open) => {
        stop()
        const target = open ? options.width : 0
        if (!options.animations() || value() === target) {
          from = target
          setValue(target)
          return
        }
        from = value()
        to = target
        const duration = open ? PANEL_OPEN_MS : PANEL_CLOSE_MS
        const curve = open ? panelSpring : panelEaseOut
        const startedAt = performance.now()
        handle = setInterval(() => {
          const progress = Math.min(1, (performance.now() - startedAt) / duration)
          setValue(from + (to - from) * curve(progress))
          if (progress >= 1) {
            from = to
            stop()
          }
        }, PANEL_FRAME_MS)
      },
      { defer: true },
    ),
  )
  return value
}

function within(node: Renderable | null | undefined, root: Renderable | undefined) {
  if (!root) return false
  for (let current = node; current; current = current.parent) {
    if (current === root) return true
  }
  return false
}

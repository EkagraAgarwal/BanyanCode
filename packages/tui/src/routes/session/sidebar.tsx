import { useData } from "../../context/data"
import { createMemo, Show, type JSX } from "solid-js"
import { useTheme } from "../../context/theme"
import { useConfig } from "../../config"
import { Slot } from "../../plugin/render"
import { withTimestampedFallback } from "@opencode/util/session-title-fallback"
import { TextAttributes, type RGBA, type ScrollAcceleration } from "@opentui/core"
import "../../component/title-shimmer"

import { getScrollAcceleration } from "../../util/scroll"
import { SESSION_SIDEBAR_WIDTH } from "../../ui/layout"

/**
 * The scrolling body of the session sidebar. The content reserves two columns on
 * the right: one for the absolute scrollbar and one so text never touches it,
 * whether or not the scrollbar is showing. Keeping the padding on the content
 * (instead of narrowing the scrollbox when the bar toggles) avoids a reflow.
 */
export function SidebarScroll(props: {
  readonly acceleration: ScrollAcceleration
  readonly background: RGBA
  readonly scrollbar: RGBA
  readonly children: JSX.Element
}) {
  return (
    <scrollbox
      id="session-sidebar-scroll"
      flexGrow={1}
      minHeight={0}
      scrollAcceleration={props.acceleration}
      // The sidebar only scrolls vertically; a horizontal bar steals a row during initial layout.
      horizontalScrollbarOptions={{ visible: false }}
      verticalScrollbarOptions={{
        // Position absolute so toggling the bar never changes the content width.
        position: "absolute",
        right: 0,
        top: 0,
        width: 1,
        height: "100%",
        trackOptions: {
          backgroundColor: props.background,
          foregroundColor: props.scrollbar,
        },
      }}
    >
      <box id="session-sidebar-content" flexShrink={0} gap={1} paddingRight={2}>
        {props.children}
      </box>
    </scrollbox>
  )
}

export function Sidebar(props: { sessionID: string; width?: number }) {
  const data = useData()
  const theme = useTheme()
  const config = useConfig().data
  const session = createMemo(() => data.session.get(props.sessionID))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.background.raised.base}
        width={props.width ?? SESSION_SIDEBAR_WIDTH}
        height="100%"
        paddingTop={props.width === undefined ? 1 : 0}
        paddingBottom={props.width === undefined ? 1 : 0}
        paddingLeft={props.width === undefined ? 2 : 1}
        paddingRight={props.width === undefined ? 2 : 1}
        position="relative"
        {...(props.width === undefined
          ? {}
          : { border: true, borderStyle: "rounded" as const, borderColor: theme.border.base })}
      >
        <box flexShrink={0} paddingRight={2} paddingBottom={1}>
          <title_shimmer
            fg={theme.text.base}
            rename={{
              pending: data.session.title.pending(props.sessionID),
              title: withTimestampedFallback(session()),
            }}
            enabled={config.animations ?? true}
            backdrop={theme.background.raised.base}
            attributes={
              data.session.title.pending(props.sessionID) && config.animations === false
                ? TextAttributes.DIM
                : TextAttributes.BOLD
            }
          >
            {withTimestampedFallback(session())}
          </title_shimmer>
        </box>
        <SidebarScroll
          acceleration={scrollAcceleration()}
          background={theme.background.raised.base}
          scrollbar={theme.scrollbar.base}
        >
          <Slot path="sidebar.content" input={{ sessionID: props.sessionID }} />
        </SidebarScroll>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <Slot path="sidebar.footer" input={{ sessionID: props.sessionID }} />
        </box>
      </box>
    </Show>
  )
}

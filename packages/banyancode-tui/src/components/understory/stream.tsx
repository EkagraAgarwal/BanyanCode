import type { RGBA, ScrollBoxRenderable } from "@opentui/core"
import { createMemo, For, Show } from "solid-js"
import { truncate } from "../../data/format"
import { returnedSummary } from "../../data/messages"
import { isLiveState, shortLabel, streamEntries, type StreamEntry, type StreamSession } from "../../data/understory"
import type { Palette } from "../../theme"
import { sproutFrame } from "../status/sprout"
import { spans, streamClock, type Span } from "./layout"
import { LineView, type Line } from "./line"
import type { LensProps } from "./view"

/** The merged, time-ordered log: one row per event, newest at the bottom. */
export interface StreamLensProps extends LensProps {
  readonly following: boolean
  /** First visible entry index while follow is paused. */
  readonly top: number
  readonly onScroll: (scroll: ScrollBoxRenderable, top: number, following: boolean) => void
}

export function StreamLens(props: StreamLensProps) {
  const sessions = createMemo((): readonly StreamSession[] =>
    props.rows.map((row) => {
      const messages = props.messages(row.sessionID)
      const returned = returnedSummary(messages, 120)
      return {
        sessionID: row.sessionID,
        label: row.label,
        state: row.state,
        messages,
        ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }),
        ...(returned === undefined ? {} : { returned }),
      }
    }),
  )
  const all = createMemo(() =>
    streamEntries(sessions(), {
      ...(props.rows.some((row) => isLiveState(row.state)) ? { now: props.view.viewT() } : {}),
    }),
  )
  const entries = createMemo(() =>
    props.view.filter() ? all().filter((entry) => entry.sessionID === props.selected) : all(),
  )
  const origin = createMemo(() => props.rows.find((row) => row.depth === 0)?.startedAt ?? 0)
  const truncated = createMemo(() =>
    props.rows.some(
      (row) => (props.view.filter() ? row.sessionID === props.selected : true) && row.historyMayBeTruncated,
    ),
  )
  const selectedRow = createMemo(() => props.rows.find((row) => row.sessionID === props.selected))

  return (
    <StreamView
      width={props.width}
      height={props.height}
      entries={entries()}
      hues={props.hues}
      theme={props.theme}
      animations={props.animations}
      time={props.tick}
      truncated={truncated()}
      origin={origin()}
      filterLabel={props.view.filter() ? `${selectedRow()?.label ?? ""} only` : "All branches"}
      filterHue={
        props.view.filter() && props.selected !== undefined ? props.hues.get(props.selected) : undefined
      }
      following={props.following}
      top={props.top}
      onScroll={props.onScroll}
    />
  )
}

function StreamView(props: {
  readonly width: number
  readonly height: number
  readonly entries: readonly StreamEntry[]
  readonly hues: ReadonlyMap<string, RGBA>
  readonly theme: Palette
  readonly animations: boolean
  readonly time: number
  readonly truncated: boolean
  readonly origin: number
  readonly filterLabel: string
  readonly filterHue?: RGBA | undefined
  readonly following: boolean
  readonly top: number
  readonly onScroll: (scroll: ScrollBoxRenderable, top: number, following: boolean) => void
}) {
  let scroll: ScrollBoxRenderable | undefined
  const inner = () => Math.max(0, props.width - 1)
  const area = () => Math.max(0, props.height - 1)
  const total = () => props.entries.length
  const start = () => {
    if (props.following) return Math.max(0, total() - area())
    return Math.max(0, Math.min(props.top, Math.max(0, total() - area())))
  }
  const slice = () => props.entries.slice(start(), start() + area())
  const spinner = () => (props.animations ? sproutFrame(props.time) : "⋯")
  const timeWidth = () => (inner() >= 60 ? 7 : 0)
  const tagWidth = () => Math.min(11, Math.max(6, Math.floor(inner() * 0.14)))
  const bodyWidth = () => Math.max(1, inner() - timeWidth() - tagWidth() - 1)

  const lineFor = (entry: StreamEntry): Line => {
    const tag = shortLabel(entry.label, tagWidth())
    const failed = entry.kind === "fail" || entry.detail?.error === true
    const prefix = streamPrefix(entry, props.animations, spinner())
    const summary = truncate(entry.summary, Math.max(1, bodyWidth() - prefix.length - (failed ? 2 : 0)))
    const parts: Span[] = []
    if (timeWidth() > 0)
      parts.push({ text: `${streamClock(Math.max(0, entry.at - props.origin)).padStart(6)} `, color: props.theme.faint })
    parts.push({ text: tag, color: props.hues.get(entry.sessionID) ?? props.theme.text, bold: true })
    parts.push({ text: " ".repeat(Math.max(1, tagWidth() - tag.length + 1)), color: props.theme.faint })
    parts.push({
      text: prefix,
      color: failed ? props.theme.error : entry.kind === "user" ? props.theme.primary : props.theme.done,
    })
    parts.push({ text: summary, color: failed ? props.theme.error : props.theme.text })
    if (failed) parts.push({ text: " !", color: props.theme.error, bold: true })
    return spans(inner(), parts)
  }

  const header = () =>
    spans(inner(), [
      {
        text: props.filterLabel,
        color: props.filterHue ?? (props.filterLabel === "All branches" ? props.theme.muted : props.theme.text),
        bold: props.filterLabel !== "All branches",
      },
      ...(props.following
        ? props.truncated
          ? [{ text: "   earlier activity not loaded", color: props.theme.warning }]
          : []
        : [
            { text: "   ↓ latest", color: props.theme.primary, bold: true },
            ...(props.truncated
              ? [{ text: "   earlier activity not loaded", color: props.theme.warning }]
              : []),
          ]),
    ])

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0} height={props.height} paddingLeft={1} overflow="hidden">
      <LineView width={inner()} spans={header()} />
      <Show
        when={total() > 0}
        fallback={
          <box flexDirection="column" flexGrow={1} minHeight={0}>
            <LineView width={inner()} spans={spans(inner(), [{ text: "No branches yet", color: props.theme.text }])} />
            <LineView
              width={inner()}
              spans={spans(inner(), [
                { text: "Agents appear here when the agent fans out.", color: props.theme.faint },
              ])}
            />
          </box>
        }
      >
        <scrollbox
          id="banyancode.understory.stream"
          height={area()}
          flexShrink={0}
          width={inner()}
          stickyScroll
          stickyStart="bottom"
          verticalScrollbarOptions={{
            visible: false,
            onChange: (position: number) => {
              if (scroll === undefined) return
              props.onScroll(scroll, position, position + area() >= total() - 0.5)
            },
          }}
          ref={(element: ScrollBoxRenderable) => {
            scroll = element
            props.onScroll(element, start(), props.following)
          }}
        >
          <box position="relative" height={total()} width={inner()} flexDirection="column">
            <For each={slice()}>
              {(entry, index) => (
                <box position="absolute" top={start() + index()} left={0} width={inner()} height={1}>
                  <LineView width={inner()} spans={lineFor(entry)} />
                </box>
              )}
            </For>
          </box>
        </scrollbox>
      </Show>
    </box>
  )
}

function streamPrefix(entry: StreamEntry, animations: boolean, spinner: string): string {
  const detail = entry.detail
  if (entry.kind === "tool" && detail !== undefined) {
    if (detail.error) return "✕ "
    if (detail.open) return animations ? `${spinner} ` : "⋯ "
    return "✓ "
  }
  if (entry.kind === "spawn") return "┬ "
  if (entry.kind === "return") return "↩ "
  if (entry.kind === "fail") return "✕ "
  if (entry.kind === "kill") return "⊘ "
  if (entry.kind === "user") return "› "
  if (entry.kind === "think") return "∴ "
  if (entry.kind === "text") return "│ "
  return "· "
}

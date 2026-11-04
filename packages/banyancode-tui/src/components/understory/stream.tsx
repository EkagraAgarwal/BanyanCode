import type { RGBA, ScrollBoxRenderable } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import { truncate } from "../../data/format"
import { returnedSummary } from "../../data/messages"
import { isLiveState, shortLabel, streamEntries, type StreamEntry, type StreamSession } from "../../data/understory"
import { durationText } from "../../data/understory-spans"
import type { Palette } from "../../theme"
import { mix } from "../../motion"
import { sproutFrame } from "../status/sprout"
import { CellGrid } from "./cells"
import { spans, streamClock, type Span } from "./layout"
import { LineView, type Line } from "./line"
import type { LensProps } from "./view"

/** The merged, time-ordered log: one row per event, newest at the bottom. */
export interface StreamLensProps extends LensProps {
  readonly following: boolean
  /** First visible entry index while follow is paused. */
  readonly top: number
  /** The header's filter toggle: selected agent only, or every branch. */
  readonly onFilter: () => void
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
  const all = createMemo(() => {
    const at = props.view.live() ? Number.POSITIVE_INFINITY : props.view.viewT()
    return streamEntries(sessions(), {
      ...(props.rows.some((row) => isLiveState(row.state)) ? { now: props.view.viewT() } : {}),
    })
      // A replay is the same log cut at the playhead: nothing after it exists.
      .filter((entry) => entry.at <= at)
  })
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
      onFilter={() => props.view.setFilter(!props.view.filter())}
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
  readonly onFilter: () => void
  readonly following: boolean
  readonly top: number
  readonly onScroll: (scroll: ScrollBoxRenderable, top: number, following: boolean) => void
}) {
  let scroll: ScrollBoxRenderable | undefined
  const [hover, setHover] = createSignal<string>()
  const inner = () => Math.max(0, props.width - 1)
  const area = () => Math.max(0, props.height - 1)
  const total = () => props.entries.length
  const start = () => {
    if (props.following) return Math.max(0, total() - area())
    return Math.max(0, Math.min(props.top, Math.max(0, total() - area())))
  }
  const slice = () => props.entries.slice(start(), start() + area())
  const spinner = () => (props.animations ? sproutFrame(props.time) : "?")
  const timeWidth = () => (inner() >= 60 ? 7 : 0)
  const tagWidth = () => Math.min(11, Math.max(6, Math.floor(inner() * 0.14)))
  const bodyWidth = () => Math.max(1, inner() - timeWidth() - tagWidth() - 1)

  const lineFor = (entry: StreamEntry, newest: boolean): Line => {
    const tag = shortLabel(entry.label, tagWidth())
    const failed = entry.kind === "fail" || entry.detail?.error === true
    const prefix = streamPrefix(entry, props.animations, spinner())
    // A finished call carries its own timing, and an edit its diff, exactly as
    // the mockup's rows read: `✓ edit updater.ts +8 −2  3.1s`.
    const detail = entry.detail
    const diff =
      detail !== undefined && (detail.added !== undefined || detail.removed !== undefined)
        ? ` +${detail.added ?? 0} −${detail.removed ?? 0}`
        : ""
    const timing =
      detail !== undefined && detail.durationMs !== undefined && !detail.open
        ? `  ${durationText(detail.durationMs)}`
        : ""
    const summary = truncate(
      `${entry.summary}${diff}${timing}`,
      Math.max(1, bodyWidth() - prefix.length - (failed ? 2 : 0)),
    )
    const parts: Span[] = []
    if (timeWidth() > 0) {
      const stamp = streamClock(Math.max(0, entry.at - props.origin))
      parts.push({ text: `${stamp.padStart(6)} `, color: props.theme.faint })
    }
    parts.push({ text: tag, color: props.hues.get(entry.sessionID) ?? props.theme.text, bold: true })
    parts.push({ text: " ".repeat(Math.max(1, tagWidth() - tag.length + 1)), color: props.theme.faint })
    parts.push({
      text: prefix,
      color: failed ? props.theme.error : entry.kind === "user" ? props.theme.primary : props.theme.done,
    })
    // The newest text blooms from the highlight into the text colour, and only
    // with animations on: with them off the line is drawn at its final colour.
    const bloom = newest && props.animations && !failed
    parts.push(...(bloom ? bloomSpans(summary, props.theme) : [{ text: summary, color: failed ? props.theme.error : props.theme.text }]))
    if (failed) parts.push({ text: " !", color: props.theme.error, bold: true })
    return spans(inner(), parts)
  }

  const headerLabel = () => {
    const filtered = props.filterLabel !== "All branches"
    return filtered ? props.filterHue ?? props.theme.text : props.theme.muted
  }

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0} height={props.height} paddingLeft={1} overflow="hidden">
      <CellGrid
        id="banyancode.understory.stream.header"
        width={Math.max(1, inner())}
        height={1}
        background={props.theme.background}
        draw={(grid) => {
          const width = Math.max(1, inner())
          const label = props.filterLabel
          const filtered = label !== "All branches"
          grid.text(
            0,
            0,
            truncate(label, width),
            hover() === "stream:filter" ? mix(headerLabel(), props.theme.text, 0.5) : headerLabel(),
            undefined,
            filtered,
          )
          grid.hit(0, 0, Math.min(label.length, width), 1, "stream:filter")
          const latest = props.following ? "" : "↓ latest"
          const latestStart = width - latest.length
          if (props.truncated && latestStart > label.length + 4) {
            grid.text(
              label.length + 3,
              0,
              truncate("earlier activity not loaded", latestStart - label.length - 4),
              props.theme.warning,
            )
          }
          if (latest === "") return
          grid.text(
            latestStart,
            0,
            latest,
            hover() === "stream:latest" ? props.theme.text : props.theme.primary,
            undefined,
            true,
          )
          grid.hit(latestStart, 0, latest.length, 1, "stream:latest")
        }}
        onHit={(region) => {
          if (region === "stream:filter") {
            props.onFilter()
            return
          }
          if (region !== "stream:latest" || scroll === undefined) return
          scroll.scrollTo(Infinity)
          props.onScroll(scroll, Number.MAX_SAFE_INTEGER, true)
        }}
        onMouseMove={(region) => {
          if (region !== hover()) setHover(region)
        }}
      />
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
                  <LineView width={inner()} spans={lineFor(entry, index() === slice().length - 1)} />
                </box>
              )}
            </For>
          </box>
        </scrollbox>
      </Show>
    </box>
  )
}

/** Characters of the newest text that carry the bloom. */
export const BLOOM_CHARS = 12

/**
 * The token bloom: the newest characters of the newest line blend from the
 * highlight colour into the text colour. Pure, so the stream can call it per
 * frame and a test can check the ramp without a renderer.
 */
export function bloomSpans(text: string, theme: Palette): Span[] {
  const glyphs = [...text]
  const head = glyphs.slice(0, Math.max(0, glyphs.length - BLOOM_CHARS)).join("")
  const tail = glyphs.slice(-BLOOM_CHARS)
  if (tail.length === 0) return []
  return [
    ...(head === "" ? [] : [{ text: head, color: theme.text }]),
    ...tail.map((glyph, index) => ({
      text: glyph,
      color: mix(theme.highlight, theme.text, (index + 1) / tail.length),
    })),
  ]
}

/** The mockup's event glyphs: ✓ tool, ↩ return, ┬ spawn, ∴ thought, │ text. */
function streamPrefix(entry: StreamEntry, animations: boolean, spinner: string): string {
  const detail = entry.detail
  if (entry.kind === "tool" && detail !== undefined) {
    if (detail.error) return "✕ "
    if (detail.open) return animations ? `${spinner} ` : "⣷ "
    return "✓ "
  }
  if (entry.kind === "spawn") return "┬ "
  if (entry.kind === "return") return "↩ "
  if (entry.kind === "fail") return "✕ "
  if (entry.kind === "kill") return "⊘ "
  if (entry.kind === "user") return "▸ "
  if (entry.kind === "think") return "∴ "
  if (entry.kind === "text") return "│ "
  return "│ "
}

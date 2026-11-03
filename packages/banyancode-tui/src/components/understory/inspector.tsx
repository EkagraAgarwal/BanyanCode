import type { RGBA } from "@opentui/core"
import { createMemo, For, Show } from "solid-js"
import { formatTokens, truncate } from "../../data/format"
import { stateGlyph, type AgentSheet, type RosterRow, type RunSheet, type ToolLetter } from "../../data/understory"
import { durationText, type AgentSpan, type StaleEdit } from "../../data/understory-spans"
import { mix } from "../../motion"
import { kindColor, type Palette } from "../../theme"
import type { PinnedCall } from "./view"
import { blastScore, fileName, type GraphData } from "./graph-data"
import { runClock, spans, stateColor, stateLabel, type Span } from "./layout"
import { LineView, type Line } from "./line"

export interface InspectorAsk {
  readonly kind: "permission" | "form"
  readonly title: string
  readonly target: string
}

/** One real touch of a file, from a tool call that named it. */
export interface FileTouch {
  readonly at: number
  readonly label: string
  readonly sessionID: string
  readonly verb: "r" | "w"
  readonly summary: string
  readonly added?: number | undefined
  readonly removed?: number | undefined
}

export interface InspectorProps {
  readonly width: number
  readonly height: number
  readonly row: RosterRow | undefined
  readonly hue: RGBA
  readonly glyph: string
  readonly glyphColor: RGBA
  readonly ask: InspectorAsk | undefined
  readonly sheet: AgentSheet | undefined
  readonly run: RunSheet | undefined
  readonly hues: ReadonlyMap<string, RGBA>
  readonly theme: Palette
  readonly animations: boolean
  readonly tick: number
  readonly now: () => number
  readonly actions: readonly string[]
  /** The tile selected in Roots, if any. */
  readonly file: string | undefined
  /** Code-graph facts; absent means the graph is not built. */
  readonly graph: GraphData | undefined
  /** The call pinned in Trace, if any. */
  readonly pinned: PinnedCall | undefined
  /** Spans per session, so the Call sheet can resolve a pinned ID. */
  readonly spans: ReadonlyMap<string, readonly AgentSpan[]>
  readonly stale: readonly StaleEdit[]
  readonly touches: (path: string) => readonly FileTouch[]
  /** Live tokens per second for one session; zero when nothing streamed. */
  readonly rate: (sessionID: string) => number
}

const KIND_NAME: Readonly<Record<ToolLetter, string>> = {
  R: "read",
  S: "search",
  E: "edit",
  $: "shell",
  V: "verify",
  W: "web",
  T: "task",
  "?": "other",
}

const KIND_ORDER: readonly ToolLetter[] = ["R", "S", "E", "$", "V", "W", "T", "?"]

/** Word-wrap `text` to `width`, splitting a word that cannot fit on its own. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return []
  const words = text.replace(/\s+/g, " ").trim().split(" ")
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    if (word === "") continue
    const candidate = line === "" ? word : `${line} ${word}`
    if (candidate.length <= width) {
      line = candidate
      continue
    }
    if (line !== "") {
      lines.push(line)
      line = ""
    }
    if (word.length <= width) {
      line = word
      continue
    }
    for (let index = 0; index < word.length; index += width) lines.push(word.slice(index, index + width))
  }
  if (line !== "") lines.push(line)
  return lines
}

/** The File / Call / Run / Agent sheet. One thing at a time, in priority order. */
export function Inspector(props: InspectorProps) {
  const inner = () => Math.max(4, props.width - 3)
  const actionRows = () => (props.actions.length > 0 ? 2 : 0)
  const contentHeight = () => Math.max(1, props.height - 1 - actionRows())
  const hueOf = (sessionID: string): RGBA => props.hues.get(sessionID) ?? props.theme.leaf
  const row = () => props.row

  const spanOf = createMemo((): AgentSpan | undefined => {
    const pinned = props.pinned
    if (pinned === undefined) return undefined
    return (props.spans.get(pinned.sessionID) ?? []).find((span) => span.id === pinned.spanID)
  })

  const mode = createMemo((): "file" | "call" | "run" | "agent" | "none" => {
    const current = row()
    if (props.file !== undefined) return "file"
    if (current === undefined) return "none"
    if (props.pinned !== undefined && props.pinned.sessionID === current.sessionID) {
      return spanOf() === undefined ? "agent" : "call"
    }
    return current.depth === 0 ? "run" : "agent"
  })

  const title = createMemo(() => {
    const value = mode()
    if (value === "file") return "FILE"
    if (value === "call") return "CALL"
    if (value === "run") return "RUN"
    if (value === "agent") return "BRANCH"
    return ""
  })

  const lines = createMemo((): Line[] => {
    const width = inner()
    const theme = props.theme
    const current = row()
    if (current === undefined) return []
    const out: Line[] = []
    const push = (parts: readonly Span[]) => out.push(spans(width, parts))
    const blank = () => out.push(spans(width, []))
    const section = (heading: string, right?: string) =>
      push([
        { text: heading, color: theme.wood, bold: true },
        ...(right === undefined ? [] : [{ text: ` ${right}`, color: theme.faint }]),
      ])
    const para = (text: string, color: RGBA = theme.muted) => {
      for (const line of wrapText(text, width)) push([{ text: line, color }])
    }

    const value = mode()

    if (value === "file") {
      const path = props.file!
      push([{ text: fileName(path), color: theme.text, bold: true }])
      para(path, theme.muted)
      blank()
      const info = props.graph?.file(path)
      if (props.graph === undefined) {
        para("Graph not built.", theme.text)
        para("Run /codegraph-build to add lines, imports, dependents and the blast score.", theme.muted)
      } else if (info === undefined) {
        para("This file is not in the code graph.", theme.muted)
      } else {
        push([
          { text: info.lines === undefined ? "unknown lines" : `${info.lines} lines`, color: theme.muted },
          { text: "  ·  ", color: theme.faint },
          { text: `${info.imports.length} imports`, color: theme.muted },
        ])
        blank()
        section("BLAST RADIUS")
        const score = blastScore(info.direct, info.transitive)
        push([
          { text: `${info.direct} direct, ${info.transitive} transitive  `, color: theme.muted },
          {
            text: score.toUpperCase(),
            color: score === "high" ? theme.error : score === "medium" ? theme.warning : theme.done,
            bold: true,
          },
        ])
        blank()
      }

      for (const alert of props.stale.filter((item) => item.path === path)) {
        section("STALE EDIT")
        para(
          `${alert.readerLabel} edited ${fileName(path)} at ${runClock(alert.editedAt)} from a read at ${runClock(alert.readAt)}, older than ${alert.writerLabel}'s edit.`,
          theme.error,
        )
        blank()
      }

      const touches = props.touches(path)
      section("TOUCHES", String(touches.length))
      if (touches.length === 0) para("Nobody has touched this file in this run.", theme.faint)
      for (const touch of touches.slice(-8).reverse()) {
        push([
          { text: `${runClock(touch.at)} `, color: theme.faint },
          { text: `${truncate(touch.label, 12)} `, color: hueOf(touch.sessionID), bold: true },
          {
            text:
              touch.verb === "w"
                ? `edit +${touch.added ?? 0} −${touch.removed ?? 0}`
                : truncate(touch.summary, Math.max(4, width - 18)),
            color: touch.verb === "w" ? theme.leaf : theme.sky,
          },
        ])
      }
      blank()

      if (info !== undefined) {
        section("DEPENDENTS", String(info.direct))
        if (info.dependents.length === 0) para("Nothing imports this file.", theme.faint)
        for (const dependent of info.dependents.slice(0, 8)) {
          push([
            {
              text: truncate(fileName(dependent), Math.max(4, width - 2)),
              color: theme.muted,
            },
          ])
        }
      }
      return out
    }

    if (value === "call") {
      const span = spanOf()!
      const label = row()?.label ?? ""
      push([{ text: `‹ ${label}`, color: props.hue, bold: true }])
      blank()
      push([
        { text: `${span.name} `, color: span.error === undefined ? theme.text : theme.error, bold: true },
        { text: span.letter, color: kindColor(span.letter, theme), bold: true },
      ])
      if (span.target !== "") para(span.target, theme.text)
      blank()
      section("TIMING")
      push([{ text: `created ${runClock(span.t0)}`, color: theme.muted }])
      const took = Math.max(0, (span.t1 ?? props.now()) - span.t0)
      push([
        { text: span.t1 === undefined ? "running " : "took ", color: theme.muted },
        { text: durationText(took), color: theme.muted },
      ])
      if (span.file !== undefined) para(span.file, theme.faint)
      blank()
      if (span.added !== undefined || span.removed !== undefined) {
        section("CHANGE")
        push([
          { text: `+${span.added ?? 0}`, color: theme.leaf, bold: true },
          { text: " ", color: theme.faint },
          { text: `−${span.removed ?? 0}`, color: theme.error, bold: true },
        ])
        blank()
      }
      if (span.error !== undefined) {
        section("FAILED")
        para(span.error, theme.error)
        blank()
      }
      if (span.output !== undefined) {
        section("OUTPUT")
        const output = wrapText(span.output, width).slice(-8)
        for (const line of output) push([{ text: line, color: theme.text }])
        blank()
      }
      return out
    }

    if (value === "run") {
      const sheet = props.run
      if (sheet === undefined) return out
      push([
        { text: `${stateGlyph(row()!.state, "◉")} `, color: props.glyphColor, bold: true },
        { text: sheet.label, color: theme.leaf, bold: true },
        { text: sheet.branches.length > 0 ? "  orchestrating" : "  idle", color: theme.muted },
      ])
      if (row()?.title !== undefined) para(row()!.title!, theme.text)
      blank()
      if (sheet.branches.length === 0) {
        para("No branches yet.", theme.muted)
        blank()
        return out
      }
      const ordered = [...sheet.branches].sort((left, right) => right.tokens - left.tokens)
      const max = ordered[0]?.tokens ?? 0
      section("TOKENS BY BRANCH")
      for (const branch of ordered.slice(0, 12)) {
        const nameWidth = Math.min(13, Math.max(4, Math.floor(width * 0.32)))
        const barWidth = Math.max(4, width - nameWidth - 8)
        const filled = max === 0 ? 0 : Math.round((branch.tokens / max) * barWidth)
        push([
          { text: truncate(branch.label, nameWidth).padEnd(nameWidth, " "), color: hueOf(branch.sessionID) },
          { text: "█".repeat(Math.max(0, Math.min(barWidth, filled))), color: mix(theme.background, hueOf(branch.sessionID), 0.8) },
          { text: ` ${formatTokens(branch.tokens)}`, color: theme.muted },
        ])
      }
      blank()
      const returned = ordered.filter((branch) => branch.returned !== undefined)
      section("RETURNED", `${returned.length} of ${ordered.length}`)
      if (returned.length === 0) para("Nothing has returned yet.", theme.faint)
      for (const branch of returned.slice(-8).reverse()) {
        push([
          { text: `${stateGlyph(branch.state, "⋯")} `, color: stateColor(branch.state, theme) },
          { text: branch.label, color: hueOf(branch.sessionID), bold: true },
        ])
        para(`  ${branch.returned ?? ""}`, theme.text)
      }
      if (sheet.truncated.length > 0) {
        blank()
        para("earlier activity not loaded for some branches", theme.warning)
      }
      return out
    }

    if (value === "none") return out

    // --- Agent sheet --------------------------------------------------------
    const agent = props.sheet
    if (agent === undefined) return out
    const state = current.state
    const left = {
      text: `${props.glyph} ${agent.label}`,
      color: current.depth === 0 ? theme.text : props.hue,
      bold: true,
    }
    const right = { text: stateLabel(state), color: stateColor(state, theme), bold: true }
    const gap = width - [...left.text].length - [...right.text].length
    push([
      { text: props.glyph, color: props.glyphColor, bold: true },
      { text: ` ${agent.label}`, color: left.color, bold: true },
      { text: " ".repeat(Math.max(1, gap)), color: theme.faint },
      right,
    ])
    if (agent.title !== undefined) para(agent.title, theme.text)
    const elapsed = runClock((current.endedAt ?? props.now()) - current.startedAt)
    if (agent.model !== undefined || current.variant !== undefined) {
      push([
        ...(agent.model === undefined
          ? []
          : [
              { text: agent.model, color: theme.sky },
              { text: " ▾", color: theme.sky },
            ]),
        ...(current.variant === undefined
          ? []
          : [
              { text: " · ", color: theme.faint },
              { text: current.variant, color: theme.sky },
              { text: " ▾", color: theme.sky },
            ]),
        { text: `  ${elapsed}`, color: theme.faint },
      ])
    } else {
      push([{ text: elapsed, color: theme.faint }])
    }
    blank()

    const currentAsk = props.ask
    if (currentAsk !== undefined) {
      const border = props.animations
        ? mix(theme.warning, theme.border, (0.5 + 0.5 * Math.sin(props.tick * Math.PI * 2)) * 0.6)
        : theme.warning
      const top = `╭─ ${currentAsk.kind === "form" ? "QUESTION" : "NEEDS YOU"} `
      push([
        { text: top, color: border },
        { text: "─".repeat(Math.max(0, width - top.length - 1)), color: border },
        { text: "╮", color: border },
      ])
      // Every row between the corners is exactly the box's inner width, so the
      // right border lines up at any width, including the key row.
      const room = Math.max(0, width - 4)
      const middle = (parts: readonly Span[]) => {
        const body = spans(room, parts)
        const used = body.reduce((total, part) => total + [...part.text].length, 0)
        push([
          { text: "│ ", color: border },
          ...body,
          { text: `${" ".repeat(Math.max(0, room - used))} │`, color: border },
        ])
      }
      if (currentAsk.kind === "form") {
        middle([{ text: currentAsk.title, color: theme.text }])
        middle([{ text: "Enter opens the session", color: theme.muted }])
      } else {
        middle([
          {
            text: `${currentAsk.title}${currentAsk.target === "" ? "" : `: ${currentAsk.target}`}`,
            color: theme.text,
          },
        ])
        // The key row keeps all three answers at every width; the wording
        // shortens rather than letting the right border fall short.
        const keys = (once: string, always: string, deny: string): Span[] => [
          { text: "a", color: theme.warning, bold: true },
          { text: once, color: theme.muted },
          { text: "A", color: theme.warning, bold: true },
          { text: always, color: theme.muted },
          { text: "d", color: theme.warning, bold: true },
          { text: deny, color: theme.muted },
        ]
        const variants = [
          keys(" allow once  ", " always  ", " deny"),
          keys(" allow  ", " always  ", " deny"),
          keys(" once  ", " all  ", " deny"),
          keys("  ", "  ", " deny"),
        ]
        const plain = (parts: readonly Span[]) => parts.reduce((total, part) => total + [...part.text].length, 0)
        middle(variants.find((parts) => plain(parts) <= room) ?? variants.at(-1)!)
      }
      push([{ text: `╰${"─".repeat(Math.max(0, width - 2))}╯`, color: border }])
      blank()
    }

    for (const alert of props.stale.filter(
      (item) => item.reader === current.sessionID || item.writer === current.sessionID,
    )) {
      section("STALE EDIT")
      if (alert.reader === current.sessionID) {
        para(
          `This branch read ${fileName(alert.path)} at ${runClock(alert.readAt)}. ${alert.writerLabel} edited it after that, and this branch edited it again at ${runClock(alert.editedAt)} without re-reading.`,
          theme.error,
        )
      } else {
        para(
          `${alert.readerLabel} edited ${fileName(alert.path)} at ${runClock(alert.editedAt)} from a read older than this branch's edit.`,
          theme.error,
        )
      }
      const otherLabel = alert.reader === current.sessionID ? alert.writerLabel : alert.readerLabel
      push([
        { text: "show on map", color: theme.sky },
        { text: "  ·  ", color: theme.faint },
        { text: `steer ${otherLabel}`, color: theme.sky },
      ])
      blank()
    }

    if (agent.output.length > 0) {
      section("OUTPUT")
      for (const line of agent.output) para(line, theme.text)
      blank()
    }

    if (agent.tools.length > 0) {
      const calls = agent.tools
      section("TOOLS", String(calls.length))
      const counts = new Map<ToolLetter, number>()
      for (const call of calls) counts.set(call.letter, (counts.get(call.letter) ?? 0) + 1)
      const kinds = KIND_ORDER.filter((letter) => (counts.get(letter) ?? 0) > 0)
      let used = 0
      const bar = kinds.flatMap((letter, index): Span[] => {
        const count = counts.get(letter) ?? 0
        const size =
          index === kinds.length - 1
            ? Math.max(0, width - used)
            : Math.max(1, Math.round((count / calls.length) * width))
        const capped = Math.max(0, Math.min(size, width - used))
        used += capped
        return capped === 0 ? [] : [{ text: "█".repeat(capped), color: kindColor(letter, theme) }]
      })
      push(bar)
      push(
        kinds.flatMap((letter, index): Span[] => [
          ...(index === 0 ? [] : [{ text: "  ", color: theme.faint }]),
          { text: `${counts.get(letter) ?? 0} ${KIND_NAME[letter]}`, color: theme.muted },
        ]),
      )
      for (const call of calls.slice(0, 6)) {
        const open = call.status === "running" || call.status === "pending"
        const mark = open ? "▸" : call.error ? "✕" : "✓"
        const duration = call.durationMs === undefined ? "" : `  ${durationText(call.durationMs)}`
        const targetRoom = Math.max(3, width - call.name.length - mark.length - duration.length - 6)
        push([
          { text: `${mark} `, color: open ? theme.leaf : call.error ? theme.error : theme.done, bold: true },
          { text: `${call.name} `, color: call.error ? theme.error : kindColor(call.letter, theme) },
          { text: truncate(call.target, targetRoom), color: theme.muted },
          ...(duration === "" ? [] : [{ text: duration, color: theme.faint }]),
        ])
      }
      blank()
    }

    if (agent.files.length > 0) {
      section("CHANGED", String(agent.files.length))
      for (const changed of agent.files.slice(0, 6)) {
        push([
          { text: truncate(fileName(changed.path), Math.max(4, width - 14)), color: theme.muted },
          ...(changed.added === undefined ? [] : [{ text: `  +${changed.added}`, color: theme.diffAdded }]),
          ...(changed.removed === undefined ? [] : [{ text: ` −${changed.removed}`, color: theme.diffRemoved }]),
        ])
      }
      blank()
    }

    section("TOKENS")
    const perSecond = props.rate(current.sessionID)
    push([
      { text: formatTokens(agent.tokens), color: theme.text, bold: true },
      ...(agent.tokens > 0 ? [{ text: `  ${Math.round(perSecond)} t/s`, color: theme.muted }] : []),
    ])
    if (agent.historyMayBeTruncated) {
      blank()
      para("earlier activity not loaded", theme.warning)
    }
    return out
  })

  return (
    <box flexDirection="column" width={props.width} height={props.height} flexShrink={0} paddingLeft={2} overflow="hidden">
      <LineView width={inner()} spans={spans(inner(), [{ text: title(), color: props.theme.wood, bold: true }])} />
      <scrollbox
        id="banyancode.understory.inspector"
        height={contentHeight()}
        flexShrink={0}
        minHeight={0}
        width={inner()}
      >
        <box flexDirection="column" width={inner()}>
          <For each={lines()}>{(line) => <LineView width={inner()} spans={line} />}</For>
        </box>
      </scrollbox>
      <Show when={actionRows() > 0}>
        <LineView
          width={inner()}
          spans={spans(inner(), [{ text: "─".repeat(inner()), color: props.theme.border }])}
        />
        <LineView
          width={inner()}
          spans={spans(
            inner(),
            props.actions.flatMap((action, index): Span[] => {
              const split = action.indexOf(" ")
              const key = split < 0 ? action : action.slice(0, split)
              const label = split < 0 ? "" : action.slice(split + 1)
              const tone = label.startsWith("kill")
                ? props.theme.error
                : label.startsWith("steer")
                  ? props.theme.leaf
                  : props.theme.primary
              return [
                ...(index === 0 ? [] : [{ text: "   ", color: props.theme.faint }]),
                { text: key, color: tone, bold: true },
                { text: ` ${label}`, color: props.theme.muted },
              ]
            }),
          )}
        />
      </Show>
    </box>
  )
}

import type { RGBA } from "@opentui/core"
import { createSignal } from "solid-js"
import { CellGrid } from "./cells"
import type { Palette } from "../../theme"
import { mix } from "../../motion"
import { LENSES, lensLabel, type Lens } from "./view"

export interface LensTabsProps {
  readonly width: number
  readonly lens: Lens
  readonly onSelect: (lens: Lens) => void
  readonly theme: Palette
  /** The run clock, `0:46`. */
  readonly clock: string
  readonly live: boolean
  /** Clicking the replay badge returns to live. */
  readonly onLive?: (() => void) | undefined
  /** The inspector toggle, drawn only while the inspector is an overlay. */
  readonly overlay?: { readonly open: boolean; readonly toggle: () => void } | undefined
  /** False while a manual scroll has paused the time window. */
  readonly following?: boolean | undefined
  /** Clicking `→ latest` resumes following the newest event. */
  readonly onLatest?: (() => void) | undefined
}

const isLens = (value: string): value is Lens => LENSES.some((lens) => lens === value)

/**
 * `Trace  Roots  Stream` on the left, the run state and clock on the right.
 * The active lens owns a highlighted cell block, so which lens is showing reads
 * without colour alone. Every control here is a mouse target: a lens, the
 * replay badge (`back to live`), and the overlay inspector's toggle.
 */
export function LensTabs(props: LensTabsProps) {
  const [hover, setHover] = createSignal<string>()
  const bright = (region: string, color: RGBA) =>
    hover() === region ? mix(color, props.theme.text, 0.5) : color
  return (
    <CellGrid
      id="banyancode.understory.lens-tabs"
      width={props.width}
      height={1}
      background={props.theme.background}
      draw={(grid) => {
        const theme = props.theme
        let x = 1
        LENSES.forEach((lens) => {
          const label = lensLabel(lens)
          const active = props.lens === lens
          const region = `lens:${lens}`
          const span = label.length + 2
          const bg = hover() === region ? theme.surfaceHigh : active ? theme.surfaceHigh : undefined
          if (active || hover() === region) grid.fill(x - 1, 0, span, 1, theme.surfaceHigh)
          grid.text(
            x,
            0,
            label,
            active ? theme.text : bright(region, theme.muted),
            bg,
            active,
          )
          grid.hit(x - 1, 0, span, 1, region)
          x += span + 2
        })

        const state = props.live ? "LIVE" : "back to live"
        const clock = props.clock
        const details =
          props.overlay === undefined ? "" : "details ›"
        const detailsWidth = details === "" ? 0 : details.length + 2
        const latest = props.following === false && props.onLatest !== undefined ? "→ latest" : ""
        const latestWidth = latest === "" ? 0 : latest.length + 2
        const stateWidth = 2 + state.length
        const width = latestWidth + detailsWidth + 1 + stateWidth + 1 + clock.length
        const start = props.width - width - 1
        if (start <= x) return

        if (latest !== "") {
          const tone = hover() === "lens:latest" ? theme.text : theme.primary
          grid.text(start, 0, latest, tone, undefined, true)
          grid.hit(start, 0, latest.length, 1, "lens:latest")
        }
        const detailX = start + latestWidth
        if (details !== "") {
          const tone = hover() === "lens:details" ? theme.text : theme.muted
          grid.text(detailX, 0, details, tone)
          grid.hit(detailX, 0, details.length, 1, "lens:details")
        }
        const stateX = detailX + detailsWidth + 1
        const live = props.live
        grid.setCell(
          stateX,
          0,
          "●",
          live
            ? theme.leaf
            : hover() === "lens:live"
              ? mix(theme.warning, theme.text, 0.5)
              : theme.warning,
        )
        grid.text(stateX + 2, 0, state, live ? theme.muted : theme.warning)
        grid.text(stateX + stateWidth + 1, 0, clock, theme.text, undefined, true)
        if (!live) grid.hit(stateX, 0, stateWidth, 1, "lens:live")
      }}
      onHit={(region) => {
        if (region === "lens:details") {
          props.overlay?.toggle()
          return
        }
        if (region === "lens:live") {
          props.onLive?.()
          return
        }
        if (region === "lens:latest") {
          props.onLatest?.()
          return
        }
        const lens = region.startsWith("lens:") ? region.slice("lens:".length) : ""
        if (isLens(lens)) props.onSelect(lens)
      }}
      onMouseMove={(region) => {
        if (region !== hover()) setHover(region)
      }}
    />
  )
}

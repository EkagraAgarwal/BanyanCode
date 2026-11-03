import { CellGrid } from "./cells"
import type { Palette } from "../../theme"
import { LENSES, lensLabel, type Lens } from "./view"

export interface LensTabsProps {
  readonly width: number
  readonly lens: Lens
  readonly onSelect: (lens: Lens) => void
  readonly theme: Palette
  /** The run clock, `0:46`. */
  readonly clock: string
  readonly live: boolean
}

const isLens = (value: string): value is Lens => LENSES.some((lens) => lens === value)

/**
 * `1 Trace  2 Roots  3 Stream` on the left, the clock on the right. The active
 * lens owns a highlighted cell block, so which lens is showing reads without
 * colour alone.
 */
export function LensTabs(props: LensTabsProps) {
  return (
    <CellGrid
      width={props.width}
      height={1}
      background={props.theme.background}
      draw={(grid) => {
        const theme = props.theme
        let x = 1
        LENSES.forEach((lens, index) => {
          const label = lensLabel(lens)
          const active = props.lens === lens
          const number = `${index + 1}`
          const span = number.length + 1 + label.length
          const bg = active ? theme.surfaceHigh : undefined
          if (active) grid.fill(x - 1, 0, span + 2, 1, theme.surfaceHigh)
          grid.text(x, 0, number, active ? theme.leaf : theme.faint, bg, active)
          grid.text(x + number.length + 1, 0, label, active ? theme.text : theme.muted, bg, active)
          grid.hit(x - 1, 0, span + 2, 1, `lens:${lens}`)
          x += span + 3
        })

        const state = props.live ? "LIVE" : "REPLAY"
        const clock = props.clock
        const width = 1 + 1 + state.length + 1 + clock.length
        const start = props.width - width
        if (start <= x) return
        grid.setCell(start, 0, "●", props.live ? theme.leaf : theme.warning)
        grid.text(start + 2, 0, state, props.live ? theme.muted : theme.warning)
        grid.text(start + 2 + state.length + 1, 0, clock, theme.text, undefined, true)
      }}
      onHit={(region) => {
        const lens = region.startsWith("lens:") ? region.slice("lens:".length) : ""
        if (isLens(lens)) props.onSelect(lens)
      }}
    />
  )
}

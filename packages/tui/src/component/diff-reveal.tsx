/** @jsxImportSource @opentui/solid */
import { BoxRenderable, type BoxOptions, type RenderContext } from "@opentui/core"
import { extend, type JSX } from "@opentui/solid"
import { splitProps } from "solid-js"
import { splitPatchHunks } from "../util/diff"
import { easeOutCubic } from "./tool-settle"

export const DIFF_OPEN_DURATION = 500
export const DIFF_CLOSE_DURATION = 400
export const REVEAL_FPS = 12

/** Rows a patch occupies in the transcript, including one header row per hunk after the first. */
export function diffRowCount(patch: string) {
  const hunks = splitPatchHunks(patch)
  return patchBodyRows(patch) + Math.max(0, hunks.length - 1)
}

function patchBodyRows(patch: string) {
  return patch.split("\n").reduce((rows, line) => {
    if (
      line.length === 0 ||
      line.startsWith("@@") ||
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("index ")
    )
      return rows
    return rows + 1
  }, 0)
}

export function revealHeight(rows: number, progress: number, direction: "open" | "close") {
  const eased = easeOutCubic(progress)
  return Math.max(0, Math.round(rows * (direction === "open" ? eased : 1 - eased)))
}

type DiffRevealOptions = BoxOptions & {
  /** Full height of the diff in rows. */
  rows?: number
  /** Animates on mount. History diffs pass false and render at full height at once. */
  active?: boolean
  open?: boolean
}

export class DiffRevealRenderable extends BoxRenderable {
  private _rows = 0
  private _active = true
  private _open = true
  private elapsed = 0
  private from = 0
  private shown = 0
  private phase: "idle" | "open" | "close" = "idle"
  private animationDuration = DIFF_OPEN_DURATION

  constructor(ctx: RenderContext, options: DiffRevealOptions = {}) {
    super(ctx, { overflow: "hidden", flexShrink: 0, ...options })
    this._rows = Math.max(0, options.rows ?? 0)
    this._open = options.open ?? true
    this.shown = this._rows
    // The `active` setter starts the reveal once Solid knows whether this diff is live.
    this._active = false
  }

  set rows(value: number) {
    const next = Math.max(0, value)
    if (next === this._rows) return
    this._rows = next
    if (this.phase !== "idle") return
    this.shown = this._open ? next : 0
    this.height = this._open ? "auto" : 0
  }

  set active(value: boolean) {
    if (value === this._active) return
    this._active = value
    if (value) {
      if (this._open) {
        this.begin("open", 0)
        return
      }
      this.shown = 0
      this.height = 0
      this.visible = false
      return
    }
    this.phase = "idle"
    this.animationFps = undefined
    this.shown = this._open ? this._rows : 0
    this.height = this._open ? "auto" : 0
    this.visible = this._open
  }

  set open(value: boolean) {
    if (value === this._open) return
    this._open = value
    if (!this._active) {
      this.shown = value ? this._rows : 0
      this.height = value ? "auto" : 0
      this.visible = value
      return
    }
    this.begin(value ? "open" : "close", value ? 0 : this.shown)
  }

  /** Rows currently painted, for tests. */
  get revealed() {
    return this.shown
  }

  private begin(direction: "open" | "close", from: number) {
    this.from = from
    this.phase = direction
    this.animationDuration = direction === "open" ? DIFF_OPEN_DURATION : DIFF_CLOSE_DURATION
    this.elapsed = 0
    if (direction === "open") this.visible = true
    this.animationFps = REVEAL_FPS
    this.apply(0)
  }

  private apply(progress: number) {
    const height =
      this.phase === "open"
        ? this.from + (this._rows - this.from) * easeOutCubic(progress)
        : this.from * (1 - easeOutCubic(progress))
    this.shown = height
    this.height = height
  }

  protected override onAnimationTick(deltaTime: number) {
    if (this.phase === "idle") return
    this.elapsed = Math.min(this.animationDuration, this.elapsed + deltaTime)
    const progress = this.animationDuration > 0 ? this.elapsed / this.animationDuration : 1
    this.apply(progress)
    if (this.elapsed < this.animationDuration) return
    this.animationFps = undefined
    if (this.phase === "open") {
      this.phase = "idle"
      this.shown = this._rows
      // Unclip at rest: the reveal only animates the rows appearing, never trims the final diff.
      this.height = "auto"
      return
    }
    this.phase = "idle"
    this.shown = 0
    this.height = 0
    this.visible = false
  }
}

extend({ diff_reveal: DiffRevealRenderable })

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    diff_reveal: typeof DiffRevealRenderable
  }
}

type Props = Omit<JSX.IntrinsicElements["box"], "ref"> & {
  rows: number
  active?: boolean
  open?: boolean
}

/** Clips a diff and grows it over 500 ms (or folds it away over 400 ms) when animations are on. */
export function DiffReveal(props: Props) {
  const [local, box] = splitProps(props, ["rows", "active", "open"])
  return (
    <diff_reveal
      {...box}
      rows={local.rows}
      open={local.open ?? true}
      active={local.active ?? true}
    />
  )
}

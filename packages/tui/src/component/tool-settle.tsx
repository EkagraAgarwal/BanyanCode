/** @jsxImportSource @opentui/solid */
import { BoxRenderable, RGBA, type BoxOptions, type RenderContext } from "@opentui/core"
import { extend, type JSX } from "@opentui/solid"
import { splitProps } from "solid-js"

export const SETTLE_DURATION = 700
// The motion spec caps animation at 12 fps; the renderer's shared clock ticks this node only while it is drawn.
export const SETTLE_FPS = 12

export const easeOutCubic = (progress: number) => 1 - (1 - Math.min(1, Math.max(0, progress))) ** 3

/** Flash strength when the row is fully settled: 1 at the moment it appears, 0 once it has faded. */
export function settleLevel(elapsed: number, duration = SETTLE_DURATION) {
  if (!(duration > 0)) return 0
  return 1 - easeOutCubic(elapsed / duration)
}

export function settleColor(base: RGBA, flash: RGBA, level: number) {
  const amount = Math.min(1, Math.max(0, level))
  return RGBA.fromValues(
    base.r + (flash.r - base.r) * amount,
    base.g + (flash.g - base.g) * amount,
    base.b + (flash.b - base.b) * amount,
    1,
  )
}

type ToolSettleOptions = BoxOptions & {
  flash?: RGBA
  base?: RGBA
  /** Starts the flash on mount. History rows pass false and never animate. */
  active?: boolean
}

export class ToolSettleRenderable extends BoxRenderable {
  private _flash = RGBA.fromValues(0, 0, 0, 1)
  private _base = RGBA.fromValues(0, 0, 0, 1)
  private _active = true
  private elapsed = 0
  private finished = false

  constructor(ctx: RenderContext, options: ToolSettleOptions = {}) {
    super(ctx, options)
    if (options.flash) this._flash = options.flash
    if (options.base) this._base = options.base
    // The `active` setter starts the flash once Solid knows whether this row is live.
    this._active = false
  }

  set flash(value: RGBA) {
    this._flash = value
    if (this._active) this.paint()
  }

  set base(value: RGBA) {
    this._base = value
    if (this._active) this.paint()
  }

  set active(value: boolean) {
    if (value === this._active) return
    this._active = value
    if (value) this.begin()
    else this.finish()
  }

  /** Remaining flash strength: 1 at the start, 0 once settled or when the row is inactive. */
  get level() {
    return this._active && !this.finished ? settleLevel(this.elapsed) : 0
  }

  private begin() {
    this.elapsed = 0
    this.finished = false
    this.animationFps = SETTLE_FPS
    this.paint()
  }

  private finish() {
    this.finished = true
    this.animationFps = undefined
    this.backgroundColor = this._base
  }

  private paint() {
    this.backgroundColor = settleColor(this._base, this._flash, this.level)
  }

  protected override onAnimationTick(deltaTime: number) {
    if (this.finished) return
    this.elapsed = Math.min(SETTLE_DURATION, this.elapsed + deltaTime)
    if (this.elapsed >= SETTLE_DURATION) {
      this.finish()
      return
    }
    this.paint()
  }
}

extend({ tool_settle: ToolSettleRenderable })

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    tool_settle: typeof ToolSettleRenderable
  }
}

type Props = Omit<JSX.IntrinsicElements["box"], "ref"> & {
  flash: RGBA
  base: RGBA
  active?: boolean
}

/** A tool row container that flashes its background once when the row appears live. */
export function ToolSettle(props: Props) {
  const [local, box] = splitProps(props, ["flash", "base", "active"])
  return <tool_settle {...box} flash={local.flash} base={local.base} active={local.active ?? true} />
}

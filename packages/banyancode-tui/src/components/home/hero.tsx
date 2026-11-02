import type { Context } from "@opencode/plugin/tui/context"
import {
  RGBA,
  Renderable,
  TextAttributes,
  type OptimizedBuffer,
  type RenderableOptions,
  type RenderContext,
} from "@opentui/core"
import { extend, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, Match, onCleanup, onMount, Switch } from "solid-js"
import { TREE_ROLES, TREE_WIDTH, createTreeFrame, treeFrame, type TreeFrame, type TreeRole } from "./banyan-tree"
import { GROWTH_END, fadeIn, type Growth } from "./growth"
import {
  WORDMARK_CELLS,
  WORDMARK_HEIGHT,
  WORDMARK_WIDTH,
  createWordmarkFrame,
  wordmarkFrame,
  type WordmarkFrame,
} from "./wordmark"

/** Rows: 0-22 tree, 23 ground rule, 24 gap, 25-28 wordmark. Matches the handoff mockup rows 1-29. */
const FULL_WIDTH = 100
const FULL_HEIGHT = 29
const RULE_ROW = 23
const RULE_CENTER = 50
const RULE_REACH = 40
const RULE_GROW_SECONDS = 2.2
const WORDMARK_LEFT = 21
const WORDMARK_TOP = 25

export const HERO_FULL_MIN = { width: 120, height: 40 }
export const HERO_COMPACT_MIN = { width: 72, height: 18 }
export const HERO_PLAIN_MIN_HEIGHT = 12

const SPACE = 32
const RULE = 0x2500

type HomeArtMode = "full" | "wordmark"

/**
 * Theme colors, resolved once per theme change. Tree roles are indexed by
 * `TREE_ROLES`; the wood mixes keep the mockup's bark-to-canopy blend.
 */
type HomeArtPalette = {
  readonly signature: string
  readonly tree: readonly RGBA[]
  readonly bright: RGBA
  readonly leaf: RGBA
  readonly highlight: RGBA
  readonly background: RGBA
  readonly border: RGBA
}

const copy = (plane: Uint16Array, offset: number, color: RGBA) => {
  const source = color.buffer
  plane[offset] = source[0]!
  plane[offset + 1] = source[1]!
  plane[offset + 2] = source[2]!
  plane[offset + 3] = source[3]!
}

const blend = (out: RGBA, from: RGBA, to: RGBA, amount: number) => {
  const t = Math.max(0, Math.min(1, amount))
  out.r = from.r + (to.r - from.r) * t
  out.g = from.g + (to.g - from.g) * t
  out.b = from.b + (to.b - from.b) * t
  out.a = 1
  return out
}

const colorKey = (color: RGBA) => `${color.buffer[0]}/${color.buffer[1]}/${color.buffer[2]}/${color.buffer[3]}`

function paletteFor(theme: Context["theme"]): HomeArtPalette {
  const growth = theme.growth
  const roles: Record<TreeRole, RGBA> = {
    leaf: growth.leaf,
    moss: growth.faded,
    deep: growth.done,
    bark: growth.wood,
    woodMoss30: blend(RGBA.fromInts(0, 0, 0), growth.wood, growth.faded, 0.3),
    woodMoss50: blend(RGBA.fromInts(0, 0, 0), growth.wood, growth.faded, 0.5),
    woodDeep25: blend(RGBA.fromInts(0, 0, 0), growth.wood, growth.done, 0.25),
    highlight: growth.highlight,
  }
  return {
    signature: [
      growth.leaf,
      growth.highlight,
      growth.done,
      growth.faded,
      growth.wood,
      growth.bright,
      theme.background.base,
      theme.border.base,
    ]
      .map(colorKey)
      .join(","),
    tree: TREE_ROLES.map((role) => roles[role]),
    bright: growth.bright,
    leaf: growth.leaf,
    highlight: growth.highlight,
    background: theme.background.base,
    border: theme.border.base,
  }
}

type Options = RenderableOptions<BanyanHomeArtRenderable> & {
  mode?: HomeArtMode
}

/**
 * Draws the Home tree and wordmark into its own frame buffer (`buffered`) through
 * `withBuffers`, so a frame is plain typed-array writes plus one blit. It is never
 * `live`: the growth clock requests a render per tick, and an unchanged frame is
 * reused, so a finished tree costs nothing.
 */
export class BanyanHomeArtRenderable extends Renderable {
  private _mode: HomeArtMode = "full"
  private _elapsed = 0
  private _palette: HomeArtPalette | undefined
  private readonly tree: TreeFrame = createTreeFrame()
  private readonly wordmark: WordmarkFrame = createWordmarkFrame()
  private drawnKey = ""

  constructor(ctx: RenderContext, options: Options = {}) {
    super(ctx, { ...options, buffered: true, live: false })
    if (options.mode) this._mode = options.mode
  }

  get mode() {
    return this._mode
  }

  set mode(value: HomeArtMode) {
    if (value === this._mode) return
    this._mode = value
    this.invalidate()
  }

  get elapsed() {
    return this._elapsed
  }

  set elapsed(value: number) {
    if (value === this._elapsed) return
    this._elapsed = value
    this.invalidate()
  }

  get palette(): HomeArtPalette | undefined {
    return this._palette
  }

  set palette(value: HomeArtPalette) {
    if (value.signature === this._palette?.signature) return
    this._palette = value
    this.invalidate()
  }

  private invalidate() {
    this.drawnKey = ""
    this.requestRender()
  }

  protected override handleFrameBufferResize(width: number, height: number) {
    this.drawnKey = ""
    super.handleFrameBufferResize(width, height)
  }

  protected override destroySelf() {
    this._palette = undefined
    this.drawnKey = ""
    super.destroySelf()
  }

  private time() {
    return this._mode === "wordmark" ? GROWTH_END : this._elapsed
  }

  protected override renderSelf(buffer: OptimizedBuffer) {
    if (!this.visible || this.isDestroyed) return
    // Without its own frame buffer (not yet sized) there is nothing safe to write into.
    if (buffer !== this.frameBuffer) return
    const palette = this._palette
    if (!palette) return
    const width = this.width
    const height = this.height
    if (width <= 0 || height <= 0) return
    const t = this.time()
    const key = `${this._mode}|${t}|${width}x${height}|${palette.signature}`
    if (key === this.drawnKey) return
    if (this._mode === "full") treeFrame(t, this.tree)
    wordmarkFrame(t, palette, this.wordmark)
    buffer.withBuffers((cells) => {
      const stride = cells.width
      const rows = Math.min(height, cells.height)
      const cols = Math.min(width, stride)
      const { char, fg, bg, attributes } = cells
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const cell = y * stride + x
          char[cell] = SPACE
          attributes[cell] = 0
          copy(fg, cell * 4, palette.background)
          copy(bg, cell * 4, palette.background)
        }
      }
      const put = (x: number, y: number, code: number, color: RGBA) => {
        if (x < 0 || y < 0 || x >= cols || y >= rows) return
        const cell = y * stride + x
        char[cell] = code
        copy(fg, cell * 4, color)
      }
      if (this._mode === "full") {
        const mask = this.tree.mask
        for (let i = 0; i < mask.length; i++) {
          const bits = mask[i]!
          if (!bits) continue
          put(i % TREE_WIDTH, Math.floor(i / TREE_WIDTH), 0x2800 + bits, palette.tree[this.tree.roles[i]!]!)
        }
        const reach = Math.round(fadeIn(t, 0, RULE_GROW_SECONDS) * RULE_REACH)
        for (let x = RULE_CENTER - reach; x < RULE_CENTER + reach; x++) put(x, RULE_ROW, RULE, palette.border)
      }
      const left = this._mode === "full" ? WORDMARK_LEFT : 0
      const top = this._mode === "full" ? WORDMARK_TOP : 0
      WORDMARK_CELLS.forEach((cell, index) => {
        if (!this.wordmark.visible[index]) return
        put(left + cell.x, top + cell.row, cell.char, this.wordmark.colors[index]!)
      })
    })
    this.drawnKey = key
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    banyan_home_art: typeof BanyanHomeArtRenderable
  }
}

extend({ banyan_home_art: BanyanHomeArtRenderable })

/**
 * The Home hero: grows a banyan once per launch, then stays still. The layout size
 * never changes while growing, so the prompt mounted below it stays put.
 */
export function BanyanHero(props: { readonly context: Context; readonly growth: Growth }) {
  const dimensions = useTerminalDimensions()
  const tier = createMemo(() => {
    const { width, height } = dimensions()
    if (width >= HERO_FULL_MIN.width && height >= HERO_FULL_MIN.height) return "full"
    if (width >= HERO_COMPACT_MIN.width && height >= HERO_COMPACT_MIN.height) return "compact"
    if (height >= HERO_PLAIN_MIN_HEIGHT) return "plain"
    return "none"
  })
  const [art, setArt] = createSignal<BanyanHomeArtRenderable>()
  const bindArt = (node: BanyanHomeArtRenderable) => {
    setArt(node)
    onCleanup(() => setArt((current) => (current === node ? undefined : current)))
  }

  createEffect(() => {
    const palette = paletteFor(props.context.theme)
    const elapsed = props.growth.elapsed()
    const node = art()
    if (!node) return
    node.palette = palette
    node.elapsed = elapsed
  })

  onMount(() => {
    const keyInput = props.context.renderer.keyInput
    if (keyInput) {
      // Never consumes the input: the prompt still receives every character.
      const finish = () => props.growth.finish()
      keyInput.on("keypress", finish)
      keyInput.on("paste", finish)
      onCleanup(() => {
        keyInput.off("keypress", finish)
        keyInput.off("paste", finish)
      })
    }
    // Leaving Home mid-growth means returning shows the finished tree.
    onCleanup(() => props.growth.finish())
    props.growth.start()
  })

  return (
    <Switch>
      <Match when={tier() === "full"}>
        <banyan_home_art width={FULL_WIDTH} height={FULL_HEIGHT} mode="full" ref={bindArt} />
      </Match>
      <Match when={tier() === "compact"}>
        <banyan_home_art width={WORDMARK_WIDTH} height={WORDMARK_HEIGHT} mode="wordmark" ref={bindArt} />
      </Match>
      <Match when={tier() === "plain"}>
        <text fg={props.context.theme.text.base} attributes={TextAttributes.BOLD} selectable={false}>
          BanyanCode
        </text>
      </Match>
    </Switch>
  )
}

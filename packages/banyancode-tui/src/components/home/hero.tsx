import type { Context } from "@opencode/plugin/tui/context"
import {
  RGBA,
  Renderable,
  TextAttributes,
  type BufferAccess,
  type OptimizedBuffer,
  type RenderableOptions,
  type RenderContext,
} from "@opentui/core"
import { extend, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, Match, onCleanup, onMount, Switch } from "solid-js"
import {
  TREE_ROLES,
  TREE_WIDTH,
  createTreeFrame,
  sparklePhases,
  treeFrame,
  twinkle,
  type TreeFrame,
  type TreeRole,
} from "./banyan-tree"
import { GROWTH_END, fadeIn, type Growth } from "./growth"
import {
  WORDMARK_CELLS,
  WORDMARK_HEIGHT,
  WORDMARK_WIDTH,
  createWordmarkFrame,
  wordmarkFrame,
  type WordmarkFrame,
} from "./wordmark"

/** Width of the art canvas; the crown is narrower and stays under it. */
const FULL_WIDTH = 100
/** Rows below the tree: ground rule, gap, then the four wordmark rows. */
const BELOW_TREE = 6
const RULE_REACH = 40
const RULE_GROW_SECONDS = 2.2
const WORDMARK_LEFT = 21

export const HERO_FULL_MIN = { width: 120, height: 40 }
export const HERO_COMPACT_MIN = { width: 72, height: 18 }
export const HERO_PLAIN_MIN_HEIGHT = 12
/** At this terminal height the hero grows a four-row-taller tree. */
export const HERO_TALL_MIN_HEIGHT = 46
/** Hero rows at the full tier: 23 tree + rule + gap + wordmark, and 27 tree + the same. */
export const HERO_FULL_ROWS = 29
export const HERO_TALL_ROWS = 33
/** The plain tier is the one-row wordmark. */
export const HERO_PLAIN_ROWS = 1

/** Home's prompt block: border, padding, input, padding, metadata, border. */
export const HOME_PROMPT_ROWS = 6
/** The resume block: a header plus three sessions. */
export const HOME_RESUME_ROWS = 4
/** The home footer row. */
export const HOME_FOOTER_ROWS = 1
/** Home spends a breathing row above and below the prompt once it is tall enough. */
export const HOME_GAP_ROWS = 2
/** Home rows from which the breathing rows are spent. */
export const HOME_ROOMY_MIN_HEIGHT = 43

/** The full hero and everything around it, minus the list: 29 + 6 + 1. */
const FULL_MIN_HOME_ROWS = HERO_FULL_ROWS + HOME_PROMPT_ROWS + HOME_FOOTER_ROWS
/** The tall hero is only worth it when the list still fits under it: 33 + 2 + 6 + 4 + 1. */
const TALL_MIN_HOME_ROWS =
  HERO_TALL_ROWS + HOME_GAP_ROWS + HOME_PROMPT_ROWS + HOME_RESUME_ROWS + HOME_FOOTER_ROWS

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

/**
 * The one source of truth for the hero's size: the layout here and the resume
 * list's eligibility both read it, so they can never disagree.
 *
 * The tier itself is the terminal's call - the mockup's thresholds do not move
 * because the host drew a tab strip - but a full hero is denied when the tree,
 * the prompt and the footer cannot fit in the rows Home really owns, and the
 * tall hero is denied unless the list still fits under it. The tree therefore
 * beats the list: chrome costs the list, never the branches.
 */
export function heroRows(width: number, terminalHeight: number, homeRows: number) {
  if (
    width >= HERO_FULL_MIN.width &&
    terminalHeight >= HERO_FULL_MIN.height &&
    homeRows >= FULL_MIN_HOME_ROWS
  ) {
    return terminalHeight >= HERO_TALL_MIN_HEIGHT && homeRows >= TALL_MIN_HOME_ROWS ? HERO_TALL_ROWS : HERO_FULL_ROWS
  }
  if (width >= HERO_COMPACT_MIN.width && terminalHeight >= HERO_COMPACT_MIN.height) return WORDMARK_HEIGHT
  if (terminalHeight >= HERO_PLAIN_MIN_HEIGHT) return HERO_PLAIN_ROWS
  return 0
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
 * The reusable scratch the ambient sparkle needs, sized once per tree height.
 * `lit` is the previous frame's sparkles and `next` the current one; the two
 * swap so a frame allocates nothing.
 */
type Sparkle = {
  readonly phases: Float32Array
  lit: Int32Array
  next: Int32Array
  readonly stamp: Uint32Array
  count: number
  generation: number
}

/**
 * Draws the Home tree and wordmark into its own frame buffer (`buffered`) through
 * `withBuffers`, so a frame is plain typed-array writes plus one blit. It is never
 * `live`: the growth clock requests a render per tick, and an unchanged frame is
 * reused, so a paused tree costs nothing.
 *
 * Once the tree is finished the frame buffer keeps the still picture and the
 * ambient ticks only repaint the cells whose leaf sparkles: no per-frame tree
 * rebuild, no cell walk, and no terminal bytes for cells that did not change.
 */
export class BanyanHomeArtRenderable extends Renderable {
  private _mode: HomeArtMode = "full"
  private _elapsed = 0
  private _ambient = 0
  private _palette: HomeArtPalette | undefined
  private _tree: TreeFrame | undefined
  private readonly wordmark: WordmarkFrame = createWordmarkFrame()
  private drawnKey = ""
  /** True once the frame buffer holds the finished tree for the current size and palette. */
  private baseDrawn = false
  private _sparkle: Sparkle | undefined

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
    this.redraw()
  }

  get elapsed() {
    return this._elapsed
  }

  set elapsed(value: number) {
    if (value === this._elapsed) return
    this._elapsed = value
    this.drawnKey = ""
    this.requestRender()
  }

  get ambient() {
    return this._ambient
  }

  set ambient(value: number) {
    if (value === this._ambient) return
    this._ambient = value
    this.drawnKey = ""
    this.requestRender()
  }

  get palette(): HomeArtPalette | undefined {
    return this._palette
  }

  set palette(value: HomeArtPalette) {
    if (value.signature === this._palette?.signature) return
    this._palette = value
    this.redraw()
  }

  /** The frame buffer is stale: repaint everything, including the finished tree. */
  private redraw() {
    this.drawnKey = ""
    this.baseDrawn = false
    this.requestRender()
  }

  protected override handleFrameBufferResize(width: number, height: number) {
    this.baseDrawn = false
    this.drawnKey = ""
    super.handleFrameBufferResize(width, height)
  }

  protected override destroySelf() {
    this._palette = undefined
    this._tree = undefined
    this._sparkle = undefined
    this.baseDrawn = false
    this.drawnKey = ""
    super.destroySelf()
  }

  private frame(): TreeFrame {
    const height = Math.max(1, this.height - BELOW_TREE)
    if (!this._tree || this._tree.height !== height) {
      this._tree = createTreeFrame(height)
      this._sparkle = undefined
    }
    return this._tree
  }

  private sparkle(height: number): Sparkle {
    const prepared = this._sparkle
    if (prepared && prepared.phases.length === TREE_WIDTH * height) return prepared
    const size = TREE_WIDTH * height
    const sparkle: Sparkle = {
      phases: sparklePhases(height),
      lit: new Int32Array(size),
      next: new Int32Array(size),
      stamp: new Uint32Array(size),
      count: 0,
      generation: 0,
    }
    this._sparkle = sparkle
    return sparkle
  }

  /**
   * Repaints only the sparkles: cells that start twinkling go to `highlight`,
   * the ones that stop go back to the colour their tree role holds. The chars,
   * the trunk, the roots, the rule and the wordmark are already in the buffer.
   */
  private paintSparkles(cells: BufferAccess, palette: HomeArtPalette, ambient: number) {
    const tree = this._tree!
    const sparkle = this.sparkle(tree.height)
    const { phases, stamp } = sparkle
    const generation = ++sparkle.generation
    const stride = cells.width
    const rows = Math.min(this.height, cells.height)
    const cols = Math.min(this.width, stride)
    const fg = cells.fg
    const next = sparkle.next
    let count = 0
    for (let cell = 0; cell < phases.length; cell++) {
      if (!tree.mask[cell]) continue
      const ph = phases[cell]!
      if (ph < 0 || !twinkle(ambient, ph)) continue
      const x = cell % TREE_WIDTH
      const y = (cell - x) / TREE_WIDTH
      if (x >= cols || y >= rows) continue
      stamp[cell] = generation
      next[count++] = cell
      copy(fg, (y * stride + x) * 4, palette.highlight)
    }
    const lit = sparkle.lit
    for (let i = 0; i < sparkle.count; i++) {
      const cell = lit[i]!
      if (stamp[cell] === generation) continue
      const x = cell % TREE_WIDTH
      const y = (cell - x) / TREE_WIDTH
      if (x >= cols || y >= rows) continue
      copy(fg, (y * stride + x) * 4, palette.tree[tree.roles[cell]!]!)
    }
    sparkle.lit = next
    sparkle.next = lit
    sparkle.count = count
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
    const t = this._elapsed
    const ambient = this._ambient
    // The finished full tree is a still picture; from here only its sparkles move.
    const still = t >= GROWTH_END && this._mode === "full"
    const key = `${this._mode}|${t}|${still ? "still" : "grow"}|${ambient}|${width}x${height}|${palette.signature}`
    if (key === this.drawnKey) return
    if (still && this.baseDrawn) {
      buffer.withBuffers((cells) => this.paintSparkles(cells, palette, ambient))
      this.drawnKey = key
      return
    }
    // A still frame carries no baked-in twinkle, so every sparkle can be undone.
    const tree = this._mode === "full" ? treeFrame(t, ambient, this.frame(), !still) : undefined
    // The wordmark's sweep belongs to the growth and to the compact tier; the
    // finished full tree keeps the frame it already drew.
    wordmarkFrame(this._mode === "wordmark" ? GROWTH_END : t, ambient, palette, this.wordmark)
    const ruleRow = height - BELOW_TREE
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
      if (tree) {
        const mask = tree.mask
        for (let i = 0; i < mask.length; i++) {
          const bits = mask[i]!
          if (!bits) continue
          put(i % TREE_WIDTH, Math.floor(i / TREE_WIDTH), 0x2800 + bits, palette.tree[tree.roles[i]!]!)
        }
        const center = Math.floor(TREE_WIDTH / 2)
        const reach = Math.round(fadeIn(t, 0, RULE_GROW_SECONDS) * RULE_REACH)
        for (let x = center - reach; x < center + reach; x++) put(x, ruleRow, RULE, palette.border)
      }
      const left = tree ? WORDMARK_LEFT : 0
      const top = tree ? ruleRow + 2 : 0
      WORDMARK_CELLS.forEach((cell, index) => {
        if (!this.wordmark.visible[index]) return
        put(left + cell.x, top + cell.row, cell.char, this.wordmark.colors[index]!)
      })
    })
    if (still) {
      // The first still frame is the frozen tree plus the sparkles it carries now.
      this.sparkle(this.frame().height).count = 0
      buffer.withBuffers((cells) => this.paintSparkles(cells, palette, ambient))
      this.baseDrawn = true
    }
    this.drawnKey = key
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    banyan_home_art: typeof BanyanHomeArtRenderable
  }
}

extend({ banyan_home_art: BanyanHomeArtRenderable })

type Tier = "full" | "compact" | "plain" | "none"

/**
 * The Home hero: grows a banyan once, then sparkles its leaves for as long as
 * Home is visible. The layout size never changes while growing, so the prompt
 * mounted below it stays put.
 *
 * After growth the picture is a cached still frame and the ambient clock only
 * repaints the dots that twinkle, nine times a second. A paused, unfocused or
 * unmounted hero holds no timer at all, so Home, the session view and every
 * other tab idle as cheaply as they did before.
 *
 * `height` is Home's real height in rows when the host passes it: chrome like the
 * session tab strip and the devtools bar is not the hero's to spend.
 */
export function BanyanHero(props: {
  readonly context: Context
  readonly growth: Growth
  readonly height?: () => number
}) {
  const dimensions = useTerminalDimensions()
  const rows = () => props.height?.() ?? dimensions().height
  const heroSize = createMemo(() => heroRows(dimensions().width, dimensions().height, rows()))
  // One tier decision, so the art and the clock can never disagree about it.
  const tier = createMemo<Tier>(() => {
    const size = heroSize()
    if (size >= HERO_FULL_ROWS) return "full"
    if (size === WORDMARK_HEIGHT) return "compact"
    if (size === HERO_PLAIN_ROWS) return "plain"
    return "none"
  })
  // Nothing is painted while the terminal reports it has no focus, so the
  // sparkle stops spending frames on a Home nobody is looking at.
  const [focused, setFocused] = createSignal(true)
  const [art, setArt] = createSignal<BanyanHomeArtRenderable>()
  const bindArt = (node: BanyanHomeArtRenderable) => {
    setArt(node)
    onCleanup(() => setArt((current) => (current === node ? undefined : current)))
  }

  onMount(() => {
    const keyInput = props.context.renderer.keyInput
    if (keyInput) {
      // Skips growth only; the ambient loop keeps running and the input is never consumed.
      const finish = () => props.growth.finish()
      keyInput.on("keypress", finish)
      keyInput.on("paste", finish)
      onCleanup(() => {
        keyInput.off("keypress", finish)
        keyInput.off("paste", finish)
      })
    }
    // Terminal focus reporting, when the host hands us the renderer: the clock
    // stops while the window is in the background and picks up where it left off.
    const renderer = props.context.renderer
    if (typeof renderer.on === "function") {
      const blur = () => setFocused(false)
      const focus = () => setFocused(true)
      renderer.on("blur", blur)
      renderer.on("focus", focus)
      onCleanup(() => {
        renderer.off("blur", blur)
        renderer.off("focus", focus)
      })
    }
    // Leaving Home pauses the loop: returning shows the finished tree and resumes it.
    onCleanup(() => {
      props.growth.finish()
      props.growth.pause()
    })
    // Nothing below the compact tier animates, so it never starts a clock at all.
    if (tier() === "full" || tier() === "compact") props.growth.resume()
  })

  // The plain tier draws no animated art, and a background window draws nothing,
  // so neither keeps the clock running.
  createEffect(() => {
    if (focused() && (tier() === "full" || tier() === "compact")) props.growth.resume()
    else props.growth.pause()
  })

  createEffect(() => {
    const node = art()
    if (!node) return
    node.palette = paletteFor(props.context.theme)
    node.elapsed = props.growth.elapsed()
    node.ambient = props.growth.ambient()
  })

  return (
    <Switch>
      <Match when={tier() === "full"}>
        <banyan_home_art width={FULL_WIDTH} height={heroSize()} mode="full" ref={bindArt} />
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

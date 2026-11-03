import { Renderable, RGBA, TextAttributes, type OptimizedBuffer, type RenderableOptions, type RenderContext } from "@opentui/core"
import { extend } from "@opentui/solid"
import { createEffect, createMemo, onCleanup } from "solid-js"

/**
 * A cell grid the lenses draw into. One renderable paints every glyph with its
 * own foreground and background, so a lane of twenty agents costs twenty times
 * the cells and none of the renderables: there is no `<text>` per span.
 *
 * The grid itself is plain data with no renderer in sight, so span and lane
 * code can build a frame in a pure function and a unit test can assert on it.
 */

const SPACE = 32
/** Lower one-eighth blocks, 1/8 through 8/8 filled from the bottom. */
const LOWER_BLOCK = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const
/** Left one-eighth blocks, 1/8 through 8/8 filled from the left. */
const LEFT_BLOCK = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const

export interface Cell {
  readonly x: number
  readonly y: number
  readonly glyph: string
  readonly fg: RGBA
  readonly bg: RGBA
  readonly bold: boolean
}

export class Grid {
  readonly width: number
  readonly height: number
  private readonly glyphs: Uint32Array
  private readonly foreground: RGBA[]
  private readonly background: RGBA[]
  private readonly bold: Uint8Array
  private readonly regions: Array<string | undefined>
  private defaultFg: RGBA
  private defaultBg: RGBA

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.floor(width))
    this.height = Math.max(1, Math.floor(height))
    const size = this.width * this.height
    this.glyphs = new Uint32Array(size).fill(SPACE)
    this.foreground = new Array<RGBA>(size).fill(RGBA.fromInts(0, 0, 0, 0))
    this.background = new Array<RGBA>(size).fill(RGBA.fromInts(0, 0, 0, 0))
    this.bold = new Uint8Array(size)
    this.regions = new Array<string | undefined>(size)
    this.defaultFg = this.foreground[0]!
    this.defaultBg = this.background[0]!
  }

  /** Resets every cell to a blank one with `background`/`foreground`, and drops hit regions. */
  clear(background: RGBA = this.defaultBg, foreground: RGBA = this.defaultFg): void {
    this.defaultBg = background
    this.defaultFg = foreground
    this.glyphs.fill(SPACE)
    this.foreground.fill(foreground)
    this.background.fill(background)
    this.bold.fill(0)
    this.regions.fill(undefined)
  }

  setCell(x: number, y: number, glyph: string, fg: RGBA, bg?: RGBA, bold = false): void {
    if (!this.inside(x, y)) return
    const index = y * this.width + x
    const point = glyph.codePointAt(0)
    this.glyphs[index] = point ?? SPACE
    this.foreground[index] = fg
    if (bg !== undefined) this.background[index] = bg
    this.bold[index] = bold ? 1 : 0
  }

  /** Writes `text` one code point per cell; returns the next free x. */
  text(x: number, y: number, text: string, fg: RGBA, bg?: RGBA, bold = false): number {
    let column = x
    for (const glyph of text) {
      this.setCell(column, y, glyph, fg, bg, bold)
      column += 1
    }
    return column
  }

  /** Right-aligns `text` so it ends at `xEnd`; returns where it started. */
  right(xEnd: number, y: number, text: string, fg: RGBA, bg?: RGBA, bold = false): number {
    return this.text(xEnd - [...text].length, y, text, fg, bg, bold)
  }

  /** Fills a rectangle with a blank cell on `bg`. */
  fill(x: number, y: number, width: number, height: number, bg: RGBA): void {
    for (let row = y; row < y + height; row += 1) {
      for (let column = x; column < x + width; column += 1) this.setCell(column, row, " ", bg, bg)
    }
  }

  /**
   * A vertical split inside one cell: the lower `eighths` of the cell carries
   * `fg` and the rest carries `bg`, so a stacked layer needs no extra row.
   */
  lowerBlock(x: number, y: number, eighths: number, fg: RGBA, bg: RGBA): void {
    const split = Math.max(0, Math.min(8, Math.round(eighths)))
    if (split === 0) {
      this.setCell(x, y, " ", fg, bg)
      return
    }
    this.setCell(x, y, LOWER_BLOCK[split]!, fg, bg)
  }

  /**
   * A horizontal split inside one cell: the left `eighths` of the cell carries
   * `fg` and the rest carries `bg`, so two adjacent spans share a cell.
   */
  leftBlock(x: number, y: number, eighths: number, fg: RGBA, bg: RGBA): void {
    const split = Math.max(0, Math.min(8, Math.round(eighths)))
    if (split === 0) {
      this.setCell(x, y, " ", fg, bg)
      return
    }
    this.setCell(x, y, LEFT_BLOCK[split]!, fg, bg)
  }

  /** Marks a rectangle as belonging to a region, for mouse hit-testing. */
  hit(x: number, y: number, width: number, height: number, id: string): void {
    for (let row = y; row < y + height; row += 1) {
      for (let column = x; column < x + width; column += 1) {
        if (this.inside(column, row)) this.regions[row * this.width + column] = id
      }
    }
  }

  hitAt(x: number, y: number): string | undefined {
    if (!this.inside(x, y)) return undefined
    return this.regions[y * this.width + x]
  }

  cell(x: number, y: number): Cell | undefined {
    if (!this.inside(x, y)) return undefined
    const index = y * this.width + x
    return {
      x,
      y,
      glyph: String.fromCodePoint(this.glyphs[index]!),
      fg: this.foreground[index]!,
      bg: this.background[index]!,
      bold: this.bold[index] === 1,
    }
  }

  cells(): readonly Cell[] {
    return Array.from({ length: this.width * this.height }, (_, index) =>
      this.cell(index % this.width, Math.floor(index / this.width)),
    ).filter((cell): cell is Cell => cell !== undefined)
  }

  /** Row text, for a test that wants the frame without a renderer. */
  lines(): string[] {
    return Array.from({ length: this.height }, (_, y) => {
      const start = y * this.width
      return String.fromCodePoint(...Array.from(this.glyphs.subarray(start, start + this.width))).trimEnd()
    })
  }

  private inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height
  }

  /** @internal Cell state for the renderable, in row-major order. */
  read(): {
    readonly glyphs: Uint32Array
    readonly foreground: readonly RGBA[]
    readonly background: readonly RGBA[]
    readonly bold: Uint8Array
  } {
    return { glyphs: this.glyphs, foreground: this.foreground, background: this.background, bold: this.bold }
  }
}

type CellGridOptions = RenderableOptions<CellGridRenderable> & {
  grid?: Grid
}

// Colours are packed to the 8-bit channels the buffer stores, so the diff is a
// numeric compare per cell with no allocation.
function pack(color: RGBA): number {
  return ((color.buffer[0]! & 255) << 24) | ((color.buffer[1]! & 255) << 16) | ((color.buffer[2]! & 255) << 8) | (color.buffer[3]! & 255)
}

export class CellGridRenderable extends Renderable {
  private cells: Grid
  private previous: { glyphs: Uint32Array; fg: Int32Array; bg: Int32Array; bold: Uint8Array } | undefined

  constructor(ctx: RenderContext, options: CellGridOptions) {
    super(ctx, options)
    this.cells = options.grid ?? new Grid(this.width || 1, this.height || 1)
  }

  get grid(): Grid {
    return this.cells
  }

  set grid(value: Grid) {
    if (this.cells === value) return
    this.cells = value
    this.requestRender()
  }

  /**
   * Publishes the drawn grid. Only a frame that differs from the last one asks
   * the renderer for work, so an idle panel stays at zero frames.
   */
  commit(): boolean {
    const current = this.cells.read()
    const size = current.glyphs.length
    const previous = this.previous
    if (previous === undefined || previous.glyphs.length !== size) {
      this.snapshot(current)
      this.requestRender()
      return true
    }
    let changed = false
    for (let index = 0; index < size && !changed; index += 1) {
      if (current.glyphs[index] !== previous.glyphs[index]) changed = true
      else if (current.bold[index] !== previous.bold[index]) changed = true
      else if (pack(current.foreground[index]!) !== previous.fg[index]) changed = true
      else if (pack(current.background[index]!) !== previous.bg[index]) changed = true
    }
    if (!changed) return false
    this.snapshot(current)
    this.requestRender()
    return true
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const grid = this.cells
    const width = Math.min(grid.width, this.width)
    const height = Math.min(grid.height, this.height)
    if (width <= 0 || height <= 0) return
    const cells = grid.read()
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * grid.width + x
        const attributes = cells.bold[index] === 1 ? TextAttributes.BOLD : 0
        buffer.setCell(
          this.screenX + x,
          this.screenY + y,
          String.fromCodePoint(cells.glyphs[index]!),
          cells.foreground[index]!,
          cells.background[index]!,
          attributes,
        )
      }
    }
  }

  private snapshot(cells: ReturnType<Grid["read"]>): void {
    const size = cells.glyphs.length
    const previous =
      this.previous !== undefined && this.previous.glyphs.length === size
        ? this.previous
        : {
            glyphs: new Uint32Array(size),
            fg: new Int32Array(size),
            bg: new Int32Array(size),
            bold: new Uint8Array(size),
          }
    previous.glyphs.set(cells.glyphs)
    previous.bold.set(cells.bold)
    cells.foreground.forEach((color, index) => (previous.fg[index] = pack(color)))
    cells.background.forEach((color, index) => (previous.bg[index] = pack(color)))
    this.previous = previous
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    cell_grid: typeof CellGridRenderable
  }
}

extend({ cell_grid: CellGridRenderable })

export interface CellGridProps {
  readonly width: number
  readonly height: number
  /** The blank a cell starts from; a lens passes the panel background. */
  readonly background: RGBA
  /** Runs inside a reactive scope: only the signals it reads redraw the frame. */
  readonly draw: (grid: Grid) => void
  readonly id?: string | undefined
  /** The renderable, for hit-testing and tests. */
  readonly onReady?: ((node: CellGridRenderable) => void) | undefined
  /** Cell hit-testing; the event coordinates are terminal cells. */
  readonly onHit?: ((region: string, grid: Grid) => void) | undefined
  readonly onMouseMove?: ((region: string | undefined, grid: Grid) => void) | undefined
  /** Wheel over the grid: `direction` is the wheel, `delta` the reported steps. */
  readonly onScroll?: ((direction: "up" | "down" | "left" | "right", delta: number) => void) | undefined
  /**
   * A drag: press on a cell, move across cells, release. `cell` is grid-local,
   * and `region` is the hit region under the pointer (undefined off any).
   */
  readonly onDragStart?: ((pointer: GridPointer) => void) | undefined
  readonly onDragMove?: ((pointer: GridPointer) => void) | undefined
  readonly onDragEnd?: ((pointer: GridPointer) => void) | undefined
}

/** Where a pointer is, in grid cells, for a drag handler. */
export interface GridPointer {
  readonly region: string | undefined
  readonly x: number
  readonly y: number
}

export function CellGrid(props: CellGridProps) {
  let renderable: CellGridRenderable | undefined
  let dragging = false
  const grid = createMemo(() => new Grid(Math.max(1, props.width), Math.max(1, props.height)))

  const publish = () => {
    const target = grid()
    target.clear(props.background)
    props.draw(target)
    if (renderable === undefined) return
    renderable.grid = target
    renderable.commit()
  }

  createEffect(publish)

  const local = (x: number, y: number) => {
    const node = renderable
    if (node === undefined) return undefined
    return node.grid.hitAt(x - node.screenX, y - node.screenY)
  }

  /** A pointer position in grid cells, plus the region under it. */
  const pointer = (x: number, y: number): GridPointer => {
    const node = renderable
    if (node === undefined) return { region: undefined, x: 0, y: 0 }
    return { region: node.grid.hitAt(x - node.screenX, y - node.screenY), x: x - node.screenX, y: y - node.screenY }
  }

  onCleanup(() => {
    dragging = false
  })

  return (
    <cell_grid
      id={props.id}
      width={Math.max(1, props.width)}
      height={Math.max(1, props.height)}
      ref={(node: CellGridRenderable) => {
        renderable = node
        props.onReady?.(node)
        publish()
      }}
      onMouseDown={(event) => {
        const node = renderable
        if (node === undefined) return
        const region = local(event.x, event.y)
        dragging = true
        props.onDragStart?.(pointer(event.x, event.y))
        if (props.onHit === undefined) return
        if (region !== undefined) props.onHit(region, node.grid)
      }}
      onMouseDrag={(event) => {
        if (!dragging) return
        props.onDragMove?.(pointer(event.x, event.y))
      }}
      onMouseDragEnd={(event) => {
        if (!dragging) return
        dragging = false
        props.onDragEnd?.(pointer(event.x, event.y))
      }}
      onMouseUp={(event) => {
        if (!dragging) return
        dragging = false
        props.onDragEnd?.(pointer(event.x, event.y))
      }}
      onMouseMove={(event) => {
        if (props.onMouseMove === undefined) return
        const node = renderable
        if (node === undefined) return
        props.onMouseMove(local(event.x, event.y), node.grid)
      }}
      onMouseScroll={(event) => {
        const scroll = event.scroll
        if (props.onScroll === undefined || scroll === undefined) return
        props.onScroll(scroll.direction, scroll.delta)
      }}
    />
  )
}

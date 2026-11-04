import {
  OptimizedBuffer,
  Renderable,
  RGBA,
  TextAttributes,
  type RenderableOptions,
  type RenderContext,
} from "@opentui/core"
import { extend } from "@opentui/solid"
import { createEffect, createMemo } from "solid-js"

/**
 * A cell grid the lenses draw into. One renderable paints every glyph with its
 * own foreground and background, so a lane of twenty agents costs twenty times
 * the cells and none of the renderables: there is no `<text>` per span.
 *
 * The grid itself is plain data with no renderer in sight, so span and lane
 * code can build a frame in a pure function and a unit test can assert on it.
 * Colours are packed bytes, not `RGBA` objects, and the grid keeps a change
 * counter: a frame that paints the same cells again costs no upload and no
 * renderer work.
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

/** RGBA to the packed 8-bit channels the buffer planes store. */
export function pack(color: RGBA): number {
  const buffer = color.buffer
  return (((buffer[0]! & 255) << 24) | ((buffer[1]! & 255) << 16) | ((buffer[2]! & 255) << 8) | (buffer[3]! & 255)) >>> 0
}

/** The inverse of `pack`, for the read path only: never called while painting. */
export function unpack(value: number): RGBA {
  return RGBA.fromInts((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255)
}

const TRANSPARENT = 0

export class Grid {
  readonly width: number
  readonly height: number
  private readonly glyphs: Uint32Array
  /** Packed 8-bit RGBA, one entry per cell. */
  private readonly foreground: Uint32Array
  private readonly background: Uint32Array
  private readonly bold: Uint8Array
  private readonly regions: Array<string | undefined>
  private defaultFg: number
  private defaultBg: number
  /** Bumped only when a cell's drawn content actually changes. */
  private changes = 0

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.floor(width))
    this.height = Math.max(1, Math.floor(height))
    const size = this.width * this.height
    this.glyphs = new Uint32Array(size).fill(SPACE)
    this.foreground = new Uint32Array(size).fill(TRANSPARENT)
    this.background = new Uint32Array(size).fill(TRANSPARENT)
    this.bold = new Uint8Array(size)
    this.regions = new Array<string | undefined>(size)
    this.defaultFg = TRANSPARENT
    this.defaultBg = TRANSPARENT
  }

  /** How many real cell changes this grid has seen; equal means an identical frame. */
  get revision(): number {
    return this.changes
  }

  /**
   * Resets every cell to a blank one with `background`/`foreground`, and drops
   * hit regions. Only cells that were not already blank are counted as changes,
   * so repainting the same frame leaves `revision` alone.
   */
  clear(background: RGBA = unpack(this.defaultBg), foreground: RGBA = unpack(this.defaultFg)): void {
    const bg = pack(background)
    const fg = pack(foreground)
    this.defaultBg = bg
    this.defaultFg = fg
    const size = this.width * this.height
    for (let index = 0; index < size; index += 1) {
      if (
        this.glyphs[index] === SPACE &&
        this.foreground[index] === fg &&
        this.background[index] === bg &&
        this.bold[index] === 0
      ) {
        continue
      }
      this.glyphs[index] = SPACE
      this.foreground[index] = fg
      this.background[index] = bg
      this.bold[index] = 0
      this.changes += 1
    }
    this.regions.fill(undefined)
  }

  setCell(x: number, y: number, glyph: string, fg: RGBA, bg?: RGBA, bold = false): void {
    if (!this.inside(x, y)) return
    this.write(x, y, glyph.codePointAt(0) ?? SPACE, pack(fg), bg === undefined ? undefined : pack(bg), bold ? 1 : 0)
  }

  /** `setCell` from already-packed channels, for the draw code's hot loops. */
  setPacked(x: number, y: number, glyph: number, fg: number, bg?: number, bold = false): void {
    if (!this.inside(x, y)) return
    this.write(x, y, glyph, fg, bg, bold ? 1 : 0)
  }

  private write(x: number, y: number, glyph: number, fg: number, bg: number | undefined, bold: number): void {
    const index = y * this.width + x
    const nextBg = bg === undefined ? this.background[index]! : bg
    if (
      this.glyphs[index] === glyph &&
      this.foreground[index] === fg &&
      this.background[index] === nextBg &&
      this.bold[index] === bold
    ) {
      return
    }
    this.glyphs[index] = glyph
    this.foreground[index] = fg
    this.background[index] = nextBg
    this.bold[index] = bold
    this.changes += 1
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
    const packed = pack(bg)
    for (let row = y; row < y + height; row += 1) {
      for (let column = x; column < x + width; column += 1) {
        if (this.inside(column, row)) this.write(column, row, SPACE, packed, packed, 0)
      }
    }
  }

  /**
   * A vertical split inside one cell: the lower `eighths` of the cell carries
   * `fg` and the rest carries `bg`, so a stacked layer needs no extra row.
   */
  lowerBlock(x: number, y: number, eighths: number, fg: RGBA, bg: RGBA): void {
    const split = Math.max(0, Math.min(8, Math.round(eighths)))
    this.setCell(x, y, LOWER_BLOCK[split]!, fg, bg)
  }

  /**
   * A horizontal split inside one cell: the left `eighths` of the cell carries
   * `fg` and the rest carries `bg`, so two adjacent spans share a cell.
   */
  leftBlock(x: number, y: number, eighths: number, fg: RGBA, bg: RGBA): void {
    const split = Math.max(0, Math.min(8, Math.round(eighths)))
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

  /** The glyph at a cell, for the "do not paint over" checks the draw code makes. */
  glyphAt(x: number, y: number): string | undefined {
    if (!this.inside(x, y)) return undefined
    return String.fromCodePoint(this.glyphs[y * this.width + x]!)
  }

  cell(x: number, y: number): Cell | undefined {
    if (!this.inside(x, y)) return undefined
    const index = y * this.width + x
    return {
      x,
      y,
      glyph: String.fromCodePoint(this.glyphs[index]!),
      fg: unpack(this.foreground[index]!),
      bg: unpack(this.background[index]!),
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
    readonly foreground: Uint32Array
    readonly background: Uint32Array
    readonly bold: Uint8Array
    readonly revision: number
    readonly width: number
    readonly height: number
  } {
    return {
      glyphs: this.glyphs,
      foreground: this.foreground,
      background: this.background,
      bold: this.bold,
      revision: this.changes,
      width: this.width,
      height: this.height,
    }
  }
}

type CellGridOptions = RenderableOptions<CellGridRenderable> & {
  grid?: Grid
}

/** Counters a test can read: an unchanged frame must leave both alone. */
export const CELL_GRID_STATS = { uploads: 0, paints: 0 }

const BOLD = TextAttributes.BOLD

/**
 * Paints a `Grid` through one owned frame buffer. The grid's cells are copied
 * into the buffer's native planes in a single `withBuffers` scope and the whole
 * rectangle is composited with one `drawFrameBuffer` call, so a 6,000-cell lens
 * costs one FFI call per frame instead of 6,000. A frame whose cells did not
 * change skips the upload entirely.
 *
 * Paint hooks can only record drawing, so the planes are not the destination's:
 * the renderable owns a scratch buffer created from the scene, exactly as
 * `OptimizedBuffer.create` documents.
 */
export class CellGridRenderable extends Renderable {
  private cells: Grid
  private scratch: OptimizedBuffer | undefined
  private uploadedRevision = -1
  private uploadedWidth = 0
  private uploadedHeight = 0

  constructor(ctx: RenderContext, options: CellGridOptions) {
    super(ctx, options)
    this.cells = options.grid ?? new Grid(this.width || 1, this.height || 1)
  }

  get grid(): Grid {
    return this.cells
  }

  set grid(value: Grid) {
    this.cells = value
  }

  /** Replaces the drawn grid; returns true when the frame actually changed. */
  publish(grid: Grid): boolean {
    if (grid !== this.cells) {
      this.cells = grid
      this.uploadedRevision = -1
    }
    const changed = grid.revision !== this.uploadedRevision
    if (changed) this.requestRender()
    return changed
  }

  /**
   * Kept for the tests and callers that publish by hand: reports whether the
   * grid has changed since the last paint, and marks that frame as published.
   */
  commit(): boolean {
    return this.publish(this.cells)
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const grid = this.cells
    const width = Math.min(grid.width, this.width)
    const height = Math.min(grid.height, this.height)
    if (width <= 0 || height <= 0) return
    const scratch = this.ensureScratch(width, height)
    if (scratch === undefined) return
    const cell = grid.read()
    if (cell.revision !== this.uploadedRevision || this.uploadedWidth !== width || this.uploadedHeight !== height) {
      this.upload(scratch, cell, width, height)
      this.uploadedRevision = cell.revision
      this.uploadedWidth = width
      this.uploadedHeight = height
      CELL_GRID_STATS.uploads += 1
    }
    CELL_GRID_STATS.paints += 1
    buffer.drawFrameBuffer(Math.trunc(this.screenX), Math.trunc(this.screenY), scratch)
  }

  private ensureScratch(width: number, height: number): OptimizedBuffer | undefined {
    if (this.scratch !== undefined && this.scratch.width === width && this.scratch.height === height) return this.scratch
    this.scratch?.destroy()
    this.scratch = OptimizedBuffer.create(width, height, this.ctx.widthMethod, {
      owner: this.ctx.nativeScene,
      id: `cell-grid-${this.id}`,
    })
    this.uploadedRevision = -1
    return this.scratch
  }

  /**
   * Copies the grid into the scratch buffer's planes. The plane layout is the
   * one `BufferAccess` documents: one `u32` glyph and one `u32` attribute per
   * cell, and four `u16` colour channels per cell (each holding a byte).
   */
  private upload(
    scratch: OptimizedBuffer,
    cell: ReturnType<Grid["read"]>,
    width: number,
    height: number,
  ): void {
    scratch.withBuffers((cells) => {
      const chars = cells.char as Uint32Array
      const fg = cells.fg as Uint16Array
      const bg = cells.bg as Uint16Array
      const attributes = cells.attributes as Uint32Array
      const stride = cells.width
      for (let y = 0; y < height; y += 1) {
        const sourceRow = y * cell.width
        const targetRow = y * stride
        for (let x = 0; x < width; x += 1) {
          const source = sourceRow + x
          const target = targetRow + x
          const foreground = cell.foreground[source]!
          const background = cell.background[source]!
          chars[target] = cell.glyphs[source]!
          attributes[target] = cell.bold[source] === 1 ? BOLD : 0
          const fgAt = target * 4
          fg[fgAt] = foreground >>> 24
          fg[fgAt + 1] = (foreground >>> 16) & 255
          fg[fgAt + 2] = (foreground >>> 8) & 255
          fg[fgAt + 3] = foreground & 255
          bg[fgAt] = background >>> 24
          bg[fgAt + 1] = (background >>> 16) & 255
          bg[fgAt + 2] = (background >>> 8) & 255
          bg[fgAt + 3] = background & 255
        }
      }
    })
  }

  protected override destroyOwnedResources(): void {
    this.scratch?.destroy()
    this.scratch = undefined
    super.destroyOwnedResources?.()
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
  readonly onScroll?: ((
    direction: "up" | "down" | "left" | "right",
    delta: number,
    modifiers?: { readonly shift: boolean; readonly alt: boolean; readonly ctrl: boolean },
  ) => void) | undefined
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
    renderable.publish(target)
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
        props.onScroll(scroll.direction, scroll.delta, event.modifiers)
      }}
    />
  )
}

import type { CellGridRenderable } from "../../src/components/understory/cells"

/** What a mounted OpenTUI app exposes to a test. */
interface Mounted {
  readonly renderer: {
    readonly root: { findDescendantById(id: string): Target | undefined }
    clearSelection?(): void
  }
  readonly mockMouse: { click(x: number, y: number): Promise<void> }
}

interface Target {
  readonly x: number
  readonly y: number
  readonly screenX: number
  readonly screenY: number
  readonly width: number
  readonly height: number
}

export const ROSTER = "banyancode.understory.roster"
export const LENS_TABS = "banyancode.understory.lens-tabs"
export const STREAM_HEADER = "banyancode.understory.stream.header"
export const TRACE = "banyancode.understory.trace"
export const ROOTS = "banyancode.understory.roots"
/** The inspector's action row buttons (`steer`, `kill`, `open session`, ...). */
export const INSPECTOR_ACTIONS = "banyancode.understory.inspector.actions"
/** The ask box's answer buttons (`allow once`, `always`, `deny`, `open session`). */
export const INSPECTOR_ASK = "banyancode.understory.inspector.ask"

async function press(app: Mounted, x: number, y: number): Promise<void> {
  app.renderer.clearSelection?.()
  await app.mockMouse.click(x, y)
}

/**
 * Click a cell that belongs to `region` on the CellGrid with `id`. `cell` picks
 * a later cell of the same region, which keeps two clicks on one control from
 * landing inside the renderer's double-click window. Panels are click-first
 * now, so a test picks a target by the region the production code registered
 * instead of by arithmetic on the layout.
 */
export async function clickRegion(app: Mounted, id: string, region: string, cell = 0): Promise<boolean> {
  const node = app.renderer.root.findDescendantById(id) as unknown as CellGridRenderable | undefined
  if (node === undefined) return false
  const grid = node.grid
  let seen = 0
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      if (grid.hitAt(x, y) !== region) continue
      if (seen < cell) {
        seen += 1
        continue
      }
      await press(app, node.screenX + x, node.screenY + y)
      return true
    }
  }
  return false
}

/** Every hit region on a grid, in row-major order, without duplicates. */
export function regions(app: Mounted, id: string): string[] {
  const node = app.renderer.root.findDescendantById(id) as unknown as CellGridRenderable | undefined
  if (node === undefined) return []
  const found: string[] = []
  const grid = node.grid
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const region = grid.hitAt(x, y)
      if (region !== undefined && !found.includes(region)) found.push(region)
    }
  }
  return found
}

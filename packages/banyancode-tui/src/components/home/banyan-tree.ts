import { fadeIn } from "./growth"

/**
 * The mockup's banyan, ported from `specs/tui-redesign-handoff/scenes.js` `tree()`.
 * Points are generated once from seed 11 and cached, so every launch grows the
 * same tree. Colors are role indices resolved through the theme by the caller.
 */
export const TREE_ROLES = [
  "leaf",
  "moss",
  "deep",
  "bark",
  "woodMoss30",
  "woodMoss50",
  "woodDeep25",
  "highlight",
] as const

export type TreeRole = (typeof TREE_ROLES)[number]

const ROLE = {
  leaf: 0,
  moss: 1,
  deep: 2,
  bark: 3,
  woodMoss30: 4,
  woodMoss50: 5,
  woodDeep25: 6,
  highlight: 7,
} satisfies Record<TreeRole, number>

export const TREE_WIDTH = 100
export const TREE_HEIGHT = 23

/** Braille dot masks by sub-row and sub-column (scenes.js `BR`). */
const BR = [
  [1, 8],
  [2, 16],
  [4, 32],
  [64, 128],
]

export type TreeFrame = {
  /** Braille dot mask per cell; 0 is empty and renders as a space. */
  readonly mask: Uint8Array
  /** `TREE_ROLES` index per cell, meaningful only where the mask is non-zero. */
  readonly roles: Uint8Array
}

export function createTreeFrame(): TreeFrame {
  return { mask: new Uint8Array(TREE_WIDTH * TREE_HEIGHT), roles: new Uint8Array(TREE_WIDTH * TREE_HEIGHT) }
}

const clamp = (value: number, min = 0, max = 1) => (value < min ? min : value > max ? max : value)

type Point = { x: number; y: number; a: number; role: number; leaf: 0 | 1; ph: number }

let cached: readonly Point[] | undefined

function points() {
  if (cached) return cached
  const r = rng(11)
  const leafs: Point[] = []
  const wood: Point[] = []
  const roots: Point[] = []
  const cx = 100
  const gy = 90
  const curve = (
    out: Point[],
    x0: number,
    y0: number,
    cxo: number,
    cyo: number,
    x1: number,
    y1: number,
    a0: number,
    a1: number,
    role: number,
  ) => {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.3) + 2
    for (let i = 0; i <= n; i++) {
      const q = i / n
      const u = 1 - q
      out.push({
        x: u * u * x0 + 2 * u * q * cxo + q * q * x1,
        y: u * u * y0 + 2 * u * q * cyo + q * q * y1,
        a: a0 + (a1 - a0) * q,
        role,
        leaf: 0,
        ph: 0,
      })
    }
  }
  const at = (
    x0: number,
    y0: number,
    cxo: number,
    cyo: number,
    x1: number,
    y1: number,
    q: number,
  ): readonly [number, number] => {
    const u = 1 - q
    return [u * u * x0 + 2 * u * q * cxo + q * q * x1, u * u * y0 + 2 * u * q * cyo + q * q * y1]
  }
  const blob = (x: number, y: number, rx: number, ry: number, n: number, a: number) => {
    for (let i = 0; i < n * 1.5; i++) {
      const th = r() * 6.283
      const d = Math.sqrt(r())
      const v = r()
      const X = x + Math.cos(th) * d * rx
      const Y = y + Math.sin(th) * d * ry
      const e = ((X - cx) / 96) ** 2 + ((Y - 46) / 44) ** 2
      // The second `r()` is short-circuited on purpose: the mockup's point stream depends on it.
      if (e > 1 || (e > 0.86 && r() < 0.5) || Y > 50) continue
      leafs.push({
        x: X,
        y: Y,
        a: a + r() * 0.2,
        role: v < 0.25 ? ROLE.deep : v < 0.65 ? ROLE.moss : ROLE.leaf,
        leaf: 1,
        ph: r() * 6.283,
      })
    }
  }
  for (let i = -6; i <= 6; i++) curve(wood, cx + i * 2.4, gy, cx + i * 1.0, 70, cx + i * 0.9, 48, 0, 0.2, ROLE.bark)
  const limbs = [
    [-1, 76, 42, 30],
    [1, 76, 42, 30],
    [-1, 62, 28, 26],
    [1, 64, 28, 26],
    [-1, 44, 18, 24],
    [1, 44, 18, 24],
    [-1, 22, 12, 22],
    [1, 22, 12, 22],
    [-1, 70, 48, 38],
    [1, 70, 48, 38],
  ]
  limbs.forEach((limb, i) => {
    const s = limb[0]!
    const x1 = cx + s * limb[1]!
    const y1 = limb[2]!
    const cxo = cx + s * limb[1]! * 0.45
    const cyo = limb[3]!
    const x0 = cx + s * 3
    const y0 = 50
    const a0 = 0.14 + i * 0.012
    const a1 = a0 + 0.24
    curve(wood, x0, y0, cxo, cyo, x1, y1, a0, a1, ROLE.woodMoss30)
    blob(x1, y1 - 3, 20, 10, 190, a1)
    for (let k = 1; k <= 3; k++) {
      const q = 0.3 + k * 0.2
      const p = at(x0, y0, cxo, cyo, x1, y1, q)
      const tx = p[0] + s * (6 + r() * 14)
      const ty = p[1] - 8 - r() * 12
      curve(wood, p[0], p[1], p[0] + s * 4, p[1] - 5, tx, ty, a0 + q * 0.24, a1 + 0.06, ROLE.woodMoss50)
      blob(tx, ty - 2, 19, 9, 150, a1 + 0.04)
    }
    const count = i < 2 || i > 7 ? 3 : i < 4 ? 2 : 1
    for (let k = 0; k < count; k++) {
      const q = 0.55 + r() * 0.42
      const p = at(x0, y0, cxo, cyo, x1, y1, q)
      const w = (r() - 0.5) * 4
      const a = 0.5 + r() * 0.22
      curve(roots, p[0], p[1], p[0] + w, (p[1] + gy) / 2, p[0] + w * 0.4, gy, a, a + 0.26, ROLE.woodDeep25)
    }
  })
  blob(cx, 14, 62, 11, 340, 0.42)
  blob(cx, 28, 50, 12, 240, 0.46)
  cached = leafs.concat(roots, wood)
  return cached
}

/**
 * The 100x23 cell grid at `t`. Wood is exact; leaves sway until 6.2s and land on
 * their generated points. Writes into `frame` when given, so a frame loop never
 * allocates: one pass over the points and one reused mask.
 */
export function treeFrame(t: number, frame: TreeFrame = createTreeFrame()): TreeFrame {
  const grow = clamp(t / 5.2)
  const sway = 1 - fadeIn(t, 5.2, 1)
  const { mask, roles } = frame
  mask.fill(0)
  for (const point of points()) {
    if (point.a > grow) continue
    const x = point.leaf ? point.x + Math.sin(t * 1.1 + point.ph) * 0.8 * sway : point.x
    plot(mask, roles, x, point.y, point.leaf && grow - point.a < 0.05 ? ROLE.highlight : point.role)
  }
  return frame
}

function plot(mask: Uint8Array, roles: Uint8Array, px: number, py: number, role: number) {
  const x = Math.round(px)
  const y = Math.round(py)
  if (x < 0 || y < 0 || x >= TREE_WIDTH * 2 || y >= TREE_HEIGHT * 4) return
  const cell = (y >> 2) * TREE_WIDTH + (x >> 1)
  mask[cell] = mask[cell]! | BR[y & 3]![x & 1]!
  roles[cell] = role
}

/** The mockup's seeded PRNG, verbatim, so the point stream stays identical. */
function rng(seed: number) {
  let s = seed
  return () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

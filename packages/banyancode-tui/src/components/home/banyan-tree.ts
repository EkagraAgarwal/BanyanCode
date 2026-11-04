import { fadeIn } from "./growth"

/**
 * The mockup's banyan, grown from seed 11 and cached per canvas height, so every
 * launch grows the same tree. Shapes are in braille dot space: two dots per
 * cell across, four down.
 *
 * The canopy is a set of overlapping billowing lobes rather than one ellipse, so
 * the crown has an uneven top, notches between lobes, tufts past the edge and
 * hanging undersides at different depths.
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
/** Tree rows at the default full tier (hero 29 rows). */
export const TREE_ROWS_SHORT = 23
/** Tree rows when the terminal is tall enough for the bigger hero (hero 33 rows). */
export const TREE_ROWS_TALL = 27

/** Braille dot masks by sub-row and sub-column (scenes.js `BR`). */
const BR = [
  [1, 8],
  [2, 16],
  [4, 32],
  [64, 128],
]

export type TreeFrame = {
  readonly width: number
  readonly height: number
  /** Braille dot mask per cell; 0 is empty and renders as a space. */
  readonly mask: Uint8Array
  /** `TREE_ROLES` index per cell, meaningful only where the mask is non-zero. */
  readonly roles: Uint8Array
}

export function createTreeFrame(height: number): TreeFrame {
  return {
    width: TREE_WIDTH,
    height,
    mask: new Uint8Array(TREE_WIDTH * height),
    roles: new Uint8Array(TREE_WIDTH * height),
  }
}

const clamp = (value: number, min = 0, max = 1) => (value < min ? min : value > max ? max : value)
const TAU = Math.PI * 2
/** One full colour drift every nine seconds. */
const CYCLE_SPEED = TAU / 9

type Point = {
  x: number
  y: number
  /** Appearance progress in `[0, 1]` of the growth clock. */
  a: number
  /** Wood role; leaves resolve their colour per frame. */
  role: number
  leaf: 0 | 1
  ph: number
  /** Static brightness bias in `[0, 1]`: dark interior, lit top-left clusters. */
  band: number
}

/**
 * Canopy lobes: centre offset and radii in dots from the default-tier crown
 * centre (100, 34), then density and how lit the cluster is (bright top-left,
 * dark underside). Lobes overlap just enough to crease into notches, and their
 * tops and bottoms sit at different depths so neither edge is an arc.
 */
const LOBES: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  // crown top: four bumps at rising heights, the tallest left of centre
  [-10, -24, 20, 9, 0.95, 0.95],
  [26, -18, 20, 10, 0.95, 0.85],
  [-40, -14, 19, 9, 0.9, 1.0],
  [48, -10, 18, 9, 0.85, 0.6],
  // shoulders
  [-58, -6, 20, 10, 0.9, 0.95],
  [-26, -4, 24, 11, 0.95, 0.8],
  [8, -6, 24, 11, 0.95, 0.65],
  [44, -8, 22, 10, 0.9, 0.5],
  [64, -2, 15, 10, 0.8, 0.35],
  // widest mid band
  [-66, 4, 18, 11, 0.85, 0.85],
  [-36, 2, 22, 12, 0.95, 0.7],
  [0, 4, 26, 12, 1.0, 0.55],
  [38, 2, 22, 12, 0.9, 0.42],
  [66, 4, 14, 10, 0.8, 0.3],
  // lower clusters, each hanging to its own depth
  [-52, 12, 18, 9, 0.9, 0.5],
  [-20, 8, 20, 8, 0.95, 0.42],
  [18, 9, 20, 8, 0.9, 0.36],
  [54, 12, 18, 9, 0.85, 0.3],
  // droops over the roots, each at its own depth
  [-70, 20, 14, 9, 0.85, 0.3],
  [-38, 22, 12, 8, 0.85, 0.34],
  [34, 21, 13, 8, 0.85, 0.32],
  [66, 19, 13, 9, 0.8, 0.26],
  // stray tufts just past the edge
  [-76, -4, 5, 6, 0.5, 0.9],
  [74, -8, 5, 6, 0.45, 0.4],
  [-30, -28, 5, 5, 0.45, 1.0],
]

/** The default-tier crown's half height: the lobes scale vertically around it. */
const BASE_HH = 28
/** Lobes are sampled a little inside their nominal radii, so the rims leave notches. */
const LOBE_TIGHTEN = 0.86

/** Limbs, as crown-relative endpoints (fraction of half width, of crown height). */
const LIMBS: ReadonlyArray<readonly [number, number]> = [
  [0.82, 0.12],
  [0.62, 0.58],
  [0.46, 0.26],
  [0.3, 0.6],
  [0.18, 0.06],
  [0.68, 0.82],
]

type Geometry = {
  cx: number
  gy: number
  trunkTop: number
  cy: number
  hh: number
  hw: number
}

function geometry(height: number): Geometry {
  const gy = height * 4 - 2
  const trunkTop = gy - Math.round(height * 1.72)
  const top = gy - Math.round(height * 3.66)
  const bottom = gy - Math.round(height * 1.2)
  return {
    cx: TREE_WIDTH,
    gy,
    trunkTop,
    cy: (top + bottom) / 2,
    hh: (bottom - top) / 2,
    hw: 76,
  }
}

const caches = new Map<number, readonly Point[]>()

function points(height: number) {
  const cached = caches.get(height)
  if (cached) return cached
  const r = rng(11)
  const leafs: Point[] = []
  const wood: Point[] = []
  const roots: Point[] = []
  const geo = geometry(height)
  const { cx, gy, trunkTop, cy, hh, hw } = geo
  const top = cy - hh
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
        band: 0,
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

  // Trunk: a solid heart with stranded flanks, so it reads as bark rather than a block.
  for (let i = -9; i <= 9; i++) {
    if (Math.abs(i) > 3 && Math.abs(i) % 2 === 0) continue
    curve(
      wood,
      cx + i,
      gy,
      cx + i * 0.75,
      (gy + trunkTop) / 2,
      cx + i * 0.4,
      trunkTop,
      0,
      0.2,
      ROLE.bark,
    )
  }

  // Limbs fan out from the fork; each also grows twigs and aerial roots.
  LIMBS.forEach((limb, index) => {
    const [fx, fy] = limb
    const y1 = top + fy * hh * 2
    const a0 = 0.13 + index * 0.012
    const a1 = a0 + 0.24
    ;[-1, 1].forEach((s) => {
      const x0 = cx + s * 3
      const x1 = cx + s * fx * hw
      const cxo = cx + s * fx * hw * 0.5
      const cyo = (trunkTop + y1) / 2
      curve(wood, x0, trunkTop, cxo, cyo, x1, y1, a0, a1, ROLE.woodMoss30)
      for (let k = 1; k <= 3; k++) {
        const q = 0.24 + k * 0.22
        const p = at(x0, trunkTop, cxo, cyo, x1, y1, q)
        const tx = p[0] + s * (5 + r() * 12)
        const ty = p[1] - 5 - r() * 10
        curve(wood, p[0], p[1], p[0] + s * 3, p[1] - 4, tx, ty, a0 + q * 0.24, a1 + 0.06, ROLE.woodMoss50)
      }
      const rootCount = index === 0 || index === 1 || index === 2 ? 1 : index === 5 ? 2 : 0
      for (let k = 0; k < rootCount; k++) {
        const q = 0.68 + r() * 0.26
        const p = at(x0, trunkTop, cxo, cyo, x1, y1, q)
        const w = (r() - 0.5) * 20
        const a = 0.46 + r() * 0.2
        curve(roots, p[0], p[1], p[0] + w * 0.5, (p[1] + gy) / 2, p[0] + w, gy, a, a + 0.26, ROLE.woodDeep25)
      }
    })
  })

  // Canopy: sample every lobe, thinning toward the rim and through clumps.
  const scale = hh / BASE_HH
  LOBES.forEach((lobe, index) => {
    const [dx, dy, frx, fry, density, lit] = lobe
    const lx = cx + dx
    const ly = cy + dy * scale
    const rx = frx * LOBE_TIGHTEN
    const ry = fry * scale * LOBE_TIGHTEN
    const seed = index * 2.399
    const attempts = Math.round(Math.PI * rx * ry * 0.95 * density)
    for (let i = 0; i < attempts; i++) {
      const th = r() * TAU
      const d = Math.sqrt(r())
      const wobble = 1 + 0.15 * Math.sin(th * 3 + seed) + 0.07 * Math.sin(th * 7 - seed * 2.1)
      const X = lx + Math.cos(th) * d * rx * wobble
      const Y = ly + Math.sin(th) * d * ry * wobble
      if (X < 2 || X > TREE_WIDTH * 2 - 2 || Y < 1) continue
      const core = 1 - d * d
      const clump = 0.3 + 0.7 * noise(X * 0.09, Y * 0.12)
      if (r() > (0.68 + 0.32 * core) * clump * density) continue
      const dist = clamp(Math.hypot(X - cx, Y - trunkTop) / (hw * 1.35))
      leafs.push({
        x: X,
        y: Y,
        a: 0.3 + 0.34 * dist + r() * 0.16,
        role: 0,
        leaf: 1,
        ph: r() * TAU,
        band: clamp(
          0.2 +
            0.95 * lit * (1.15 - d * 0.95) -
            0.18 * clamp((Y - top) / (hh * 2)) +
            (noise(X * 0.2 + 7, Y * 0.26) - 0.5) * 0.3,
        ),
      })
    }
  })

  // Wood under the leaves: branches read as darker gaps through the canopy.
  const all = wood.concat(roots, leafs)
  caches.set(height, all)
  return all
}

/** Total generated points at a canvas height, for the budget check. */
export function treePointCount(height: number) {
  return points(height).length
}

const sparkleCache = new Map<number, Float32Array>()

/**
 * Per-cell phase of the leaf that paints that cell last, or -1 where the cell
 * holds no leaf. This is the same last-point-wins rule `plot` uses, so a cell
 * sparkles exactly where the full redraw would have painted it `highlight`; the
 * finished tree then costs one phase test per cell instead of a whole redraw.
 */
export function sparklePhases(height: number): Float32Array {
  const cached = sparkleCache.get(height)
  if (cached) return cached
  const phases = new Float32Array(TREE_WIDTH * height).fill(-1)
  for (const point of points(height)) {
    if (!point.leaf) continue
    const x = Math.round(point.x)
    const y = Math.round(point.y)
    if (x < 0 || y < 0 || x >= TREE_WIDTH * 2 || y >= height * 4) continue
    phases[(y >> 2) * TREE_WIDTH + (x >> 1)] = point.ph
  }
  sparkleCache.set(height, phases)
  return phases
}

/** Threshold on the ambient sine that lights a leaf: the mockup's twinkle. */
const TWINKLE = 0.994

/**
 * True while this leaf phase sparkles at `ambient` seconds. The only animation
 * that survives growth, so it is deliberately one cheap sine per cell.
 */
export function twinkle(ambient: number, ph: number) {
  return Math.sin(ambient * 0.9 + ph * 7) > TWINKLE
}

/**
 * The grid at a growth `elapsed` and loop `ambient` time, in seconds. Gating uses
 * the growth clock so `finish()` shows the whole tree at once; sway, twinkle and
 * the colour drift use the ambient clock, which keeps running afterwards.
 *
 * `sparkle: false` freezes the twinkle out, leaving the still tree the ambient
 * loop sparkles on top of (see `sparklePhases`).
 */
export function treeFrame(
  elapsed: number,
  ambient: number,
  frame: TreeFrame = createTreeFrame(TREE_ROWS_SHORT),
  sparkle = true,
): TreeFrame {
  const grow = clamp(elapsed / 5.2)
  // Sway and the loop-only effects fade in over the tail of the growth so the handoff is seamless.
  const blend = fadeIn(elapsed, 5.2, 1.2)
  const { mask, roles, width } = frame
  const cx = TREE_WIDTH
  const cy = geometry(frame.height).cy
  mask.fill(0)
  for (const point of points(frame.height)) {
    if (point.a > grow) continue
    if (point.leaf) {
      const sway = Math.sin(ambient * 1.1 + point.ph) * 0.8 * blend
      const wave = Math.sin(
        ambient * CYCLE_SPEED + point.ph * 0.7 + (point.x - cx) * 0.02 - (point.y - cy) * 0.03,
      )
      const band = point.band + wave * 0.16
      const flash = sparkle && blend > 0.4 && twinkle(ambient, point.ph)
      const role =
        flash || grow - point.a < 0.05
          ? ROLE.highlight
          : band < 0.34
            ? ROLE.moss
            : band < 0.66
              ? ROLE.deep
              : ROLE.leaf
      plot(mask, roles, width, point.x + sway, point.y, frame.height, role)
      continue
    }
    plot(mask, roles, width, point.x, point.y, frame.height, point.role)
  }
  return frame
}

function plot(
  mask: Uint8Array,
  roles: Uint8Array,
  width: number,
  px: number,
  py: number,
  height: number,
  role: number,
) {
  const x = Math.round(px)
  const y = Math.round(py)
  if (x < 0 || y < 0 || x >= width * 2 || y >= height * 4) return
  const cell = (y >> 2) * width + (x >> 1)
  mask[cell] = mask[cell]! | BR[y & 3]![x & 1]!
  roles[cell] = role
}

/** Low-frequency value noise so clusters and gaps are uneven, never a uniform hatch. */
function noise(x: number, y: number) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const hash = (a: number, b: number) => {
    const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
    return n - Math.floor(n)
  }
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const a = hash(xi, yi)
  const b = hash(xi + 1, yi)
  const c = hash(xi, yi + 1)
  const d = hash(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

/** The mockup's seeded PRNG, so the point stream is stable across launches. */
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

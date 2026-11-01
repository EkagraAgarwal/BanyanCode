/**
 * Terminal force-layout for the v1 `tab-graph` canvas.
 *
 * v1 used `d3-force` (a dependency @opencode/tui carries, not this package).
 * The algorithm below is a self-contained replacement: the same 200-tick
 * synchronous simulation with charge/link/centre forces, tuned for a terminal
 * grid, so the port does not add a dependency.
 */

export interface LayoutNode {
  id: string
  name: string
  kind: string
  file?: string
  line?: number
  x?: number
  y?: number
  fx?: number
  fy?: number
}

export interface LayoutEdge {
  source: string
  target: string
  kind?: string
}

const TICKS = 200
const CHARGE = 220
const LINK_DISTANCE = 7
const CENTER_GRAVITY = 0.02
const DAMPING = 0.82

export function computeLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  width: number,
  height: number,
  rootId?: string,
): LayoutNode[] {
  if (nodes.length === 0) return []

  const scale = Math.sqrt(Math.max(0.25, (width * height) / (80 * 24)))
  const cx = width / 2
  const cy = height / 2
  const radius = Math.max(2, Math.min(width, height) / 4)
  const cloned = nodes.map((node) => ({ ...node }))

  cloned.forEach((node, index) => {
    const angle = (2 * Math.PI * index) / cloned.length
    node.x ??= cx + radius * Math.cos(angle)
    node.y ??= cy + radius * Math.sin(angle)
  })

  const root = rootId === undefined ? undefined : cloned.find((node) => node.id === rootId)
  if (root) {
    root.x = cx
    root.y = cy
    root.fx = cx
    root.fy = cy
  }

  const byID = new Map(cloned.map((node) => [node.id, node]))
  const links = edges.flatMap((edge) => {
    const source = byID.get(edge.source)
    const target = byID.get(edge.target)
    return source && target ? [{ source, target }] : []
  })

  const velocity = new Map(cloned.map((node) => [node.id, { x: 0, y: 0 }]))
  const charge = CHARGE * scale
  const distance = LINK_DISTANCE * scale

  for (let tick = 0; tick < TICKS; tick++) {
    for (let i = 0; i < cloned.length; i++) {
      const a = cloned[i]!
      for (let j = i + 1; j < cloned.length; j++) {
        const b = cloned[j]!
        let dx = (a.x ?? cx) - (b.x ?? cx)
        let dy = (a.y ?? cy) - (b.y ?? cy)
        if (dx === 0 && dy === 0) {
          dx = (i % 2 === 0 ? 1 : -1) * 0.01
          dy = (j % 2 === 0 ? 1 : -1) * 0.01
        }
        const squared = dx * dx + dy * dy
        const force = charge / Math.max(1, squared)
        const distance = Math.sqrt(squared) || 1
        const fx = (dx / distance) * force
        const fy = (dy / distance) * force
        const va = velocity.get(a.id)!
        const vb = velocity.get(b.id)!
        va.x += fx
        va.y += fy
        vb.x -= fx
        vb.y -= fy
      }
    }

    for (const link of links) {
      const dx = (link.target.x ?? cx) - (link.source.x ?? cx)
      const dy = (link.target.y ?? cy) - (link.source.y ?? cy)
      const length = Math.sqrt(dx * dx + dy * dy) || 1
      const force = (length - distance) * 0.08
      const fx = (dx / length) * force
      const fy = (dy / length) * force
      const vs = velocity.get(link.source.id)!
      const vt = velocity.get(link.target.id)!
      vs.x += fx
      vs.y += fy
      vt.x -= fx
      vt.y -= fy
    }

    for (const node of cloned) {
      const v = velocity.get(node.id)!
      v.x += (cx - (node.x ?? cx)) * CENTER_GRAVITY
      v.y += (cy - (node.y ?? cy)) * CENTER_GRAVITY
      v.x *= DAMPING
      v.y *= DAMPING
      if (node.fx === undefined) node.x = clamp((node.x ?? cx) + v.x, 0, width - 18)
      if (node.fy === undefined) node.y = clamp((node.y ?? cy) + v.y, 0, height - 1)
    }
  }

  for (const node of cloned) {
    node.x = clamp(node.x ?? cx, 0, width - 18)
    node.y = clamp(node.y ?? cy, 0, height - 1)
  }

  return cloned
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.max(min, Math.min(max, value))
}

const EDGE_CHARS = {
  empty: " ",
  horiz: "─",
  vert: "│",
  cross: "┼",
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  tUp: "┴",
  tDown: "┬",
  tLeft: "┤",
  tRight: "├",
} as const

type EdgeChar = keyof typeof EDGE_CHARS

const MERGE: Partial<Record<`${EdgeChar}|${EdgeChar}`, EdgeChar>> = {
  "horiz|horiz": "horiz",
  "vert|vert": "vert",
  "horiz|vert": "cross",
  "vert|horiz": "cross",
  "tRight|horiz": "tRight",
  "tLeft|horiz": "tLeft",
  "tUp|vert": "tUp",
  "tDown|vert": "tDown",
  "tRight|vert": "cross",
  "tLeft|vert": "cross",
  "horiz|tRight": "tRight",
  "horiz|tLeft": "tLeft",
  "vert|tUp": "tUp",
  "vert|tDown": "tDown",
  "vert|tRight": "cross",
  "vert|tLeft": "cross",
}

const mergeChar = (a: EdgeChar, b: EdgeChar): EdgeChar => MERGE[`${a}|${b}`] ?? MERGE[`${b}|${a}`] ?? "cross"

const charForSegment = (dx: number, dy: number, prev?: { x: number; y: number }, next?: { x: number; y: number }): EdgeChar => {
  if (prev && next) {
    if (prev.y === next.y) return "horiz"
    if (prev.x === next.x) return "vert"
    if ((prev.x < next.x) === (prev.y < next.y)) return "bl"
    return "br"
  }
  if (dx === 0) return "vert"
  if (dy === 0) return "horiz"
  if (dx > 0 && dy > 0) return "bl"
  if (dx > 0 && dy < 0) return "tl"
  if (dx < 0 && dy > 0) return "br"
  return "tr"
}

export function renderEdgeCanvas(nodes: LayoutNode[], edges: LayoutEdge[], width: number, height: number): string[] {
  if (width <= 0 || height <= 0) return []
  const canvas: EdgeChar[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => "empty" as EdgeChar),
  )

  const positions = new Map<string, { x: number; y: number }>()
  for (const node of nodes) {
    if (node.x === undefined || node.y === undefined) continue
    const x = Math.round(node.x)
    const y = Math.round(node.y)
    if (x < 0 || x >= width || y < 0 || y >= height) continue
    positions.set(node.id, { x, y })
  }

  const plot = (x: number, y: number, ch: EdgeChar) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const current = canvas[y]![x]!
    canvas[y]![x] = current === "empty" ? ch : current === ch ? current : mergeChar(current, ch)
  }

  for (const edge of edges) {
    const a = positions.get(edge.source)
    const b = positions.get(edge.target)
    if (!a || !b) continue
    const { x: x0, y: y0 } = a
    const { x: x1, y: y1 } = b
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    if (steps === 0) continue
    const sx = (x1 - x0) / steps
    const sy = (y1 - y0) / steps
    let prev: { x: number; y: number } | undefined
    for (let i = 1; i <= steps; i++) {
      const next = { x: Math.round(x0 + sx * i), y: Math.round(y0 + sy * i) }
      plot(next.x, next.y, charForSegment(sx, sy, prev, i < steps ? next : undefined))
      prev = next
    }
  }

  return canvas.map((row) => row.map((ch) => EDGE_CHARS[ch]).join(""))
}

import { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide, forceX, forceY, type SimulationNodeDatum } from "d3-force"

export interface LayoutNode extends SimulationNodeDatum {
  id: string
  name: string
  kind: string
  file?: string
  line?: number
}

export interface LayoutEdge {
  source: string
  target: string
}

export function computeLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  width: number,
  height: number,
  rootId?: string,
): LayoutNode[] {
  if (nodes.length === 0) return []

  // Scale force parameters with viewport area to prevent crowding or over-spreading
  // Baseline area is 80x24 = 1920
  const baselineArea = 80 * 24
  const currentArea = width * height
  const areaRatio = currentArea / baselineArea
  // Use square-root scaling to avoid extreme values while still scaling appropriately
  const scale = Math.sqrt(areaRatio)

  const clonedNodes = nodes.map((n) => ({ ...n }))
  const clonedEdges = edges.map((e) => ({ ...e }))

  // Initialize positions in a circle around center
  const cx = width / 2
  const cy = height / 2
  const radius = Math.min(width, height) / 4

  clonedNodes.forEach((n, i) => {
    if (n.x === undefined || n.y === undefined) {
      const angle = (2 * Math.PI * i) / clonedNodes.length
      n.x = cx + radius * Math.cos(angle)
      n.y = cy + radius * Math.sin(angle)
    }
  })

  // Fix root node at center
  if (rootId) {
    const root = clonedNodes.find((n) => n.id === rootId)
    if (root) {
      root.fx = cx
      root.fy = cy
    }
  }

  // Run simulation with tuned parameters for a terminal grid
  // Scale forces with viewport area to prevent crowding (small screens) or over-spreading (large screens)
  const sim = forceSimulation(clonedNodes)
    .force("charge", forceManyBody().strength(-12 * scale))
    .force("link", forceLink(clonedEdges).id((d: any) => d.id).distance(6 * scale))
    .force("center", forceCenter(cx, cy))
    .force("collide", forceCollide(2.5 * scale))
    .force("x", forceX(cx).strength(0.4))
    .force("y", forceY(cy).strength(0.4))
    .stop()

  // Run synchronously
  for (let i = 0; i < 200; i++) sim.tick()

  // Clamp coordinates within the viewport. x is clamped to width - 18 to leave room
  // for the 14-char truncated label + "● " bullet without text wrapping or clipping.
  clonedNodes.forEach((n) => {
    n.x = Math.max(0, Math.min(width - 18, n.x ?? cx))
    n.y = Math.max(0, Math.min(height - 1, n.y ?? cy))
  })

  return clonedNodes
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
}

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

const mergeChar = (a: EdgeChar, b: EdgeChar): EdgeChar =>
  MERGE[`${a}|${b}`] ?? MERGE[`${b}|${a}`] ?? "cross"

const charForSegment = (dx: number, dy: number, prev: { x: number; y: number } | undefined, next: { x: number; y: number } | undefined): EdgeChar => {
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

export function renderEdgeCanvas(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  width: number,
  height: number,
): string[] {
  if (width <= 0 || height <= 0) return []
  const canvas: EdgeChar[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => "empty" as EdgeChar),
  )

  const positions = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    if (n.x === undefined || n.y === undefined) continue
    const x = Math.round(n.x)
    const y = Math.round(n.y)
    if (x < 0 || x >= width || y < 0 || y >= height) continue
    positions.set(n.id, { x, y })
  }

  const plot = (x: number, y: number, ch: EdgeChar) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const cur = canvas[y]![x]!
    if (cur === "empty") {
      canvas[y]![x] = ch
    } else if (cur !== ch) {
      canvas[y]![x] = mergeChar(cur, ch)
    }
  }

  for (const e of edges) {
    const a = positions.get(e.source)
    const b = positions.get(e.target)
    if (!a || !b) continue
    let { x: x0, y: y0 } = a
    const { x: x1, y: y1 } = b
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    if (steps === 0) continue
    const sx = (x1 - x0) / steps
    const sy = (y1 - y0) / steps
    let prev: { x: number; y: number } | undefined
    for (let i = 1; i <= steps; i++) {
      const next = { x: Math.round(x0 + sx * i), y: Math.round(y0 + sy * i) }
      const segChar = charForSegment(sx, sy, prev, i < steps ? next : undefined)
      plot(next.x, next.y, segChar)
      prev = next
    }
  }

  return canvas.map((row) => row.map((ch) => EDGE_CHARS[ch]).join(""))
}

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

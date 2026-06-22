import { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide, type SimulationNodeDatum } from "d3-force"

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

  // Initialize positions in a circle around center
  const cx = width / 2
  const cy = height / 2
  const radius = Math.min(width, height) / 3

  nodes.forEach((n, i) => {
    if (n.x === undefined || n.y === undefined) {
      const angle = (2 * Math.PI * i) / nodes.length
      n.x = cx + radius * Math.cos(angle)
      n.y = cy + radius * Math.sin(angle)
    }
  })

  // Fix root node at center
  if (rootId) {
    const root = nodes.find((n) => n.id === rootId)
    if (root) {
      root.fx = cx
      root.fy = cy
    }
  }

  // Run simulation
  const sim = forceSimulation(nodes)
    .force("charge", forceManyBody().strength(-150))
    .force("link", forceLink(edges).id((d: any) => d.id).distance(60))
    .force("center", forceCenter(cx, cy))
    .force("collide", forceCollide(20))
    .stop()

  // Run synchronously
  for (let i = 0; i < 200; i++) sim.tick()

  return nodes
}

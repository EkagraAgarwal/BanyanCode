/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { CodegraphCanvas } from "../src/components/panels/graph"
import { computeLayout, renderEdgeCanvas } from "../src/data/graph-layout"
import type { CodegraphEdge, CodegraphNode } from "../src/data/pending-rpc"
import { codegraphLive, context, mount } from "./harness"

const nodes: CodegraphNode[] = [
  { id: "n1", fileID: "src/core.ts", kind: "function", name: "run", startLine: 10, endLine: 20 },
  { id: "n2", fileID: "src/a.ts", kind: "function", name: "callerA", startLine: 1, endLine: 3 },
  { id: "n3", fileID: "src/b.ts", kind: "method", name: "callerB", startLine: 5, endLine: 8 },
  { id: "n4", fileID: "src/c.ts", kind: "class", name: "Dependent", startLine: 30, endLine: 60 },
]

const edges: CodegraphEdge[] = [
  { id: "e1", fromNodeID: "n2", toNodeID: "n1", kind: "calls" },
  { id: "e2", fromNodeID: "n3", toNodeID: "n1", kind: "calls" },
  { id: "e3", fromNodeID: "n1", toNodeID: "n4", kind: "returns" },
]

test("codegraph canvas renders the L1 caller neighborhood", async () => {
  const app = await mount(
    () => (
      <CodegraphCanvas
        context={context()}
        codegraph={codegraphLive({ graph: { nodes, edges } })}
      />
    ),
    { width: 100, height: 40 },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Codegraph")
    expect(frame).toContain("L1 Callers")
    expect(frame).toContain("run")
    expect(frame).toContain("callerA")
    expect(frame).toContain("callerB")
    expect(frame).toContain("src/core.ts:10")
  } finally {
    app.renderer.destroy()
  }
})

test("codegraph canvas keeps the empty state when the graph is not built", async () => {
  const app = await mount(
    () => (
      <CodegraphCanvas
        context={context()}
        codegraph={codegraphLive({ graph: { nodes: [], edges: [] } })}
      />
    ),
    { width: 100, height: 30 },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("No nodes for this layer")
    expect(frame).toContain("/codegraph-build")
  } finally {
    app.renderer.destroy()
  }
})

test("computeLayout clamps nodes into the viewport and renderEdgeCanvas draws rows", () => {
  const layout = computeLayout(
    nodes.map((node) => ({ id: node.id, name: node.name, kind: node.kind })),
    edges.map((edge) => ({ source: edge.fromNodeID, target: edge.toNodeID })),
    40,
    12,
    "n1",
  )
  expect(layout).toHaveLength(4)
  for (const node of layout) {
    expect(node.x).toBeGreaterThanOrEqual(0)
    expect(node.x).toBeLessThanOrEqual(22)
    expect(node.y).toBeGreaterThanOrEqual(0)
    expect(node.y).toBeLessThanOrEqual(11)
  }
  const canvas = renderEdgeCanvas(layout, edges.map((edge) => ({ source: edge.fromNodeID, target: edge.toNodeID })), 40, 12)
  expect(canvas).toHaveLength(12)
  expect(canvas.every((row) => row.length === 40)).toBe(true)
})

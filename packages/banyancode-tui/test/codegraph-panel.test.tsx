/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { CodegraphPanel } from "../src/components/sidebar/codegraph-panel"
import type { CodegraphEdge, CodegraphNode } from "../src/data/pending-rpc"
import { codegraphLive, context, mount } from "./harness"

const NODES: readonly CodegraphNode[] = [
  { id: "n1", fileID: "f1", kind: "function", name: "CodegraphIndexer.build", startLine: 10, endLine: 20 },
  { id: "n2", fileID: "f2", kind: "method", name: "RepositoryWave2.run", startLine: 30, endLine: 44 },
  { id: "n3", fileID: "f3", kind: "function", name: "buildHandler", startLine: 2, endLine: 8 },
]

const EDGES: readonly CodegraphEdge[] = [
  { id: "e1", fromNodeID: "n2", toNodeID: "n1", kind: "calls" },
  { id: "e2", fromNodeID: "n3", toNodeID: "n1", kind: "references" },
  { id: "e3", fromNodeID: "n1", toNodeID: "n2", kind: "returns" },
]

test("codegraph panel renders layer counts and the graph overview", async () => {
  const app = await mount(
    () => (
      <CodegraphPanel
        context={context()}
        codegraph={codegraphLive({
          readiness: { reason: "ready", autoBuilt: false },
          graph: { nodes: NODES, edges: EDGES },
          meta: {
            graphVersion: 7,
            graphCoverage: 0.8,
            graphBuiltAt: Date.now() - 60_000,
            totalFiles: 10,
            totalNodes: 42,
            totalEdges: 90,
          },
        })}
      />
    ),
    { width: 80, height: 30 },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("CODEGRAPH LAYERS")
    expect(frame).toContain("Around CodegraphIndexer.build")
    expect(frame).toContain("L1 Callers (Direct)")
    expect(frame).toContain("L3 Dependents")
    expect(frame).toContain("Coverage 80% (8/10 files)")
    expect(frame).toContain("Nodes 42")
    expect(frame).toContain("Edges 90")
  } finally {
    app.renderer.destroy()
  }
})

test("codegraph panel explains how to build when no graph exists", async () => {
  const app = await mount(
    () => (
      <CodegraphPanel
        context={context()}
        codegraph={codegraphLive({ readiness: { reason: "missing", autoBuilt: false }, graph: { nodes: [], edges: [] } })}
      />
    ),
    { width: 80, height: 20 },
  )

  try {
    expect(app.captureCharFrame()).toContain("Codegraph not built")
    expect(app.captureCharFrame()).toContain("/codegraph-build")
  } finally {
    app.renderer.destroy()
  }
})

test("codegraph panel states when the RPC namespace is missing", async () => {
  const app = await mount(
    () => <CodegraphPanel context={context()} codegraph={codegraphLive({ availability: "unavailable" })} />,
    { width: 80, height: 20 },
  )

  try {
    expect(app.captureCharFrame()).toContain("not available")
  } finally {
    app.renderer.destroy()
  }
})

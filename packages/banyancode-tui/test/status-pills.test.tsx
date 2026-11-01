/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { StatusPills, graphPill } from "../src/components/status/pills"
import type { CodegraphLive } from "../src/data/live"
import { codegraphLive, context, meshLive, mount, meshNode, session } from "./harness"

async function frameOf(codegraph: CodegraphLive) {
  const app = await mount(
    () => (
      <box flexDirection="row">
        <StatusPills context={context()} codegraph={codegraph} mesh={meshLive()} />
      </box>
    ),
    { width: 80, height: 4 },
  )
  try {
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

test("graph pill covers every readiness state", () => {
  expect(graphPill({ availability: "available", readiness: { reason: "missing", autoBuilt: false } })).toEqual({
    label: "Graph: not built",
    severity: "error",
  })
  expect(graphPill({ availability: "available", readiness: { reason: "ready", autoBuilt: false } })).toEqual({
    label: "Graph: built",
    severity: "success",
  })
  expect(graphPill({ availability: "available", readiness: { reason: "stale", autoBuilt: false } })).toEqual({
    label: "Graph: stale",
    severity: "warning",
  })
  expect(graphPill({ availability: "available", readiness: { reason: "building", autoBuilt: false } })).toEqual({
    label: "Graph: building",
    severity: "info",
  })
  expect(graphPill({ availability: "available", readiness: { reason: "failed", autoBuilt: false } })).toEqual({
    label: "Graph: build failed",
    severity: "error",
  })
  expect(graphPill({ availability: "unavailable" })).toEqual({ label: "Graph: —", severity: "neutral" })
})

test("graph pill prefers a live build over persisted readiness", () => {
  expect(
    graphPill({
      availability: "available",
      readiness: { reason: "ready", autoBuilt: false },
      build: { status: "running", done: 3, total: 10 },
    }),
  ).toEqual({ label: "Graph: building", severity: "info" })

  expect(
    graphPill({
      availability: "available",
      readiness: { reason: "missing", autoBuilt: false },
      build: { status: "failed", done: 0, total: 0, error: "boom" },
    }),
  ).toEqual({ label: "Graph: build failed", severity: "error" })
})

test("graph pill reports syncing and paused watcher states", () => {
  expect(
    graphPill({
      availability: "available",
      readiness: { reason: "ready", autoBuilt: false },
      autoUpdate: { status: "draining", pending: 4 },
    }),
  ).toEqual({ label: "Graph: syncing (4)", severity: "info" })
  expect(
    graphPill({
      availability: "available",
      readiness: { reason: "ready", autoBuilt: false },
      autoUpdate: { status: "paused", pending: 0 },
    }),
  ).toEqual({ label: "Graph: paused", severity: "warning" })
})

test("status pills render the built graph and live agent count", async () => {
  const root = session({ id: "ses_root", title: "root" })
  const child = session({ id: "ses_child", parentID: "ses_root", title: "worker" })
  const app = await mount(
    () => (
      <StatusPills
        context={context({ sessions: [root, child], running: new Set(["ses_child"]) })}
        sessionID="ses_root"
        codegraph={codegraphLive({ readiness: { reason: "ready", autoBuilt: false } })}
        mesh={meshLive({
          root: meshNode({
            sessionID: "ses_root",
            state: "running",
            children: [meshNode({ sessionID: "ses_child", state: "running" })],
          }),
        })}
      />
    ),
    { width: 80, height: 4 },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("1 active")
    expect(frame).toContain("Graph: built")
  } finally {
    app.renderer.destroy()
  }
})

test("status pills render when a graph namespace is unavailable", async () => {
  const frame = await frameOf(codegraphLive({ availability: "unavailable" }))
  expect(frame).toContain("Graph: —")
})

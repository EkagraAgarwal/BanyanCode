/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { StatusPills, graphPill, packPills, pillBudget, statusPills } from "../src/components/status/pills"
import type { CodegraphLive } from "../src/data/live"
import { codegraphLive, context, meshLive, mount, meshNode, session, systemLive } from "./harness"

async function frameOf(codegraph: CodegraphLive) {
  const app = await mount(
    () => (
      <box flexDirection="row">
        <StatusPills context={context()} codegraph={codegraph} mesh={meshLive()} system={systemLive()} />
      </box>
    ),
    { width: 120, height: 4 },
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
        system={systemLive()}
      />
    ),
    { width: 120, height: 4 },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("1 active")
    expect(frame).toContain("Graph: built")
  } finally {
    app.renderer.destroy()
  }
})

test("status pills stay silent when a graph namespace is unavailable", async () => {
  const frame = await frameOf(codegraphLive({ availability: "unavailable" }))
  expect(frame).not.toContain("Graph")
  expect(frame.trim()).toBe("")
})

test("status pills never render a zero count or crowd a narrow footer", async () => {
  const app = await mount(
    () => (
      <box flexDirection="row">
        <StatusPills
          context={context()}
          codegraph={codegraphLive({ readiness: { reason: "ready", autoBuilt: false } })}
          mesh={meshLive()}
          system={systemLive()}
        />
      </box>
    ),
    { width: 44, height: 4 },
  )
  try {
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("0 active")
    expect(frame.trim()).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("pill width budget reserves the host footer and packs in priority order", () => {
  expect(pillBudget(44)).toBe(0)
  expect(pillBudget(72)).toBe(16)
  expect(pillBudget(80)).toBe(24)
  expect(pillBudget(100)).toBe(44)
  expect(pillBudget(160)).toBe(104)
  const pills = statusPills({
    activeAgents: 2,
    graph: { label: "Graph: built", severity: "success" },
    lsp: { enabled: true, connected: 1 },
    yolo: false,
    swarm: false,
  })
  expect(pills.map((pill) => pill.label)).toEqual(["Graph: built", "● 2 active"])
  expect(packPills(pills, 20).map((pill) => pill.id)).toEqual(["graph"])
  expect(packPills(pills, 0)).toEqual([])
})

test("status pills keep the v1 LSP, yolo and swarm indicators", async () => {
  const app = await mount(
    () => (
      <StatusPills
        context={context()}
        codegraph={codegraphLive({ readiness: { reason: "ready", autoBuilt: false } })}
        mesh={meshLive({ swarmMode: true })}
        system={systemLive({
          yolo: true,
          lsp: {
            enabled: true,
            servers: [{ id: "typescript", status: "configured", languages: ["typescript"], inert: false, disabled: false }],
          },
        })}
      />
    ),
    { width: 160, height: 4 },
  )
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("LSP")
    expect(frame).toContain("[yolo]")
    expect(frame).toContain("[swarm]")
  } finally {
    app.renderer.destroy()
  }
})

test("session status never renders a zero attention count", async () => {
  const { SessionStatus } = await import("../src/components/status/session-status")
  const root = session({ id: "ses_zero", title: "zero" })
  const app = await mount(() => <SessionStatus context={context({ sessions: [root] })} sessionID="ses_zero" />, {
    width: 100,
    height: 4,
  })
  try {
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("need attention")
    expect(frame.trim()).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("session status shows attention only when non-zero and wide enough", async () => {
  const { SessionStatus } = await import("../src/components/status/session-status")
  const root = session({ id: "ses_attention", title: "attention" })
  const base = context({ sessions: [root] })
  const withPermission = {
    ...base,
    data: {
      ...base.data,
      session: {
        ...base.data.session,
        permission: {
          ...base.data.session.permission,
          list: () => [{ id: "perm_1" }, { id: "perm_2" }] as never,
        },
      },
    },
  } as typeof base
  const wide = await mount(() => <SessionStatus context={withPermission} sessionID="ses_attention" />, {
    width: 100,
    height: 4,
  })
  const narrow = await mount(() => <SessionStatus context={withPermission} sessionID="ses_attention" />, {
    width: 44,
    height: 4,
  })
  try {
    expect(wide.captureCharFrame()).toContain("▲ 2 need attention")
    expect(narrow.captureCharFrame().trim()).toBe("")
  } finally {
    wide.renderer.destroy()
    narrow.renderer.destroy()
  }
})

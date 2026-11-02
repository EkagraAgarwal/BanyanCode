/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Context, SlotClaim } from "@opencode/plugin/tui/context"
import type { JSX } from "solid-js"
import BanyanTui from "../src/tui"
import { AgentsPanel } from "../src/components/sidebar/agents"
import { AgentTreePanel } from "../src/components/sidebar/agent-tree"
import { CodebaseTreePanel } from "../src/components/sidebar/codebase-tree"
import { CodegraphIntelPanel } from "../src/components/sidebar/codegraph-intel-panel"
import { CodegraphPanel } from "../src/components/sidebar/codegraph-panel"
import { IntelTracePanel } from "../src/components/sidebar/intel-trace-panel"
import { PerformancePanel } from "../src/components/sidebar/performance"
import { ProviderUsagePanel } from "../src/components/sidebar/provider-usage"
import { SystemPanel } from "../src/components/sidebar/system-status"
import { ToolUsagePanel } from "../src/components/sidebar/tool-usage"
import {
  assistant,
  codegraphLive,
  context,
  intelLive,
  meshLive,
  meshNode,
  mount,
  session,
  systemLive,
  usageLive,
} from "./harness"

const root = session({ id: "ses_root", title: "root", cost: 0.42 })
const child = session({ id: "ses_child", parentID: "ses_root", title: "worker", agent: "coder" })
const sessions = [root, child]
const messages = { ses_root: [assistant([{ name: "read" }, { name: "grep" }])] }

const fixture = {
  sessions,
  messages,
  codegraph: codegraphLive({
    readiness: { reason: "ready", autoBuilt: false },
    graph: {
      nodes: [{ id: "n1", fileID: "f1", kind: "function", name: "run", startLine: 1, endLine: 2 }],
      edges: [],
    },
    files: [
      { id: "f1", path: "src/a.ts", contentHash: "h", language: "typescript", indexedAt: 1 },
      { id: "f2", path: "src/nested/b.ts", contentHash: "h", language: "typescript", indexedAt: 1 },
    ],
  }),
  mesh: meshLive({ root: meshNode({ sessionID: "ses_root", state: "running", children: [meshNode({ sessionID: "ses_child", state: "running", agent: "coder" })] }) }),
  system: systemLive({ status: { cpuPercent: 12, memoryUsedBytes: 4 * 1024 ** 3, memoryTotalBytes: 16 * 1024 ** 3, diskUsedBytes: 100 * 1024 ** 3, diskTotalBytes: 500 * 1024 ** 3, platform: "windows" } }),
  usage: usageLive({
    tools: [{ toolId: "repository_query", useCount: 4, lastUsedAt: Math.floor(Date.now() / 1000) - 60 }],
    providers: [
      {
        providerID: "anthropic",
        displayName: "Anthropic",
        status: "available",
        confidence: "exact",
        windows: [{ id: "5h", label: "5h", kind: "rate_limit", remainingPercent: 72, resetsAt: Date.now() + 3_600_000 }],
        fetchedAt: Date.now(),
      },
    ],
  }),
  intel: intelLive(),
}

const views: ReadonlyArray<{ readonly name: string; readonly render: (ctx: Context) => JSX.Element }> = [
  { name: "codegraph", render: (ctx) => <CodegraphPanel context={ctx} codegraph={fixture.codegraph} /> },
  { name: "agents", render: (ctx) => <AgentsPanel context={ctx} sessionID="ses_root" mesh={fixture.mesh} /> },
  { name: "agent-tree", render: (ctx) => <AgentTreePanel context={ctx} sessionID="ses_root" mesh={fixture.mesh} /> },
  { name: "performance", render: (ctx) => <PerformancePanel context={ctx} sessionID="ses_root" /> },
  { name: "system", render: (ctx) => <SystemPanel context={ctx} system={fixture.system} /> },
  { name: "provider-usage", render: (ctx) => <ProviderUsagePanel context={ctx} sessionID="ses_root" usage={fixture.usage} /> },
  { name: "tool-usage", render: (ctx) => <ToolUsagePanel context={ctx} usage={fixture.usage} codegraph={fixture.codegraph} /> },
  { name: "codebase-tree", render: (ctx) => <CodebaseTreePanel context={ctx} codegraph={fixture.codegraph} /> },
  { name: "codegraph-intel", render: (ctx) => <CodegraphIntelPanel context={ctx} intel={fixture.intel} /> },
  { name: "intel-trace", render: (ctx) => <IntelTracePanel context={ctx} sessionID="ses_root" intel={fixture.intel} /> },
]

// The sidebar wrapper owns the inter-plugin gap. Every panel therefore starts
// its own content on the first terminal row (marginTop 0) and never emits a
// leading blank line of its own.
for (const view of views) {
  test(`sidebar panel ${view.name} starts on the first row`, async () => {
    const app = await mount(() => view.render(context(fixture)), { width: 80, height: 25 })
    try {
      const lines = app.captureCharFrame().split("\n")
      expect(lines[0]!.trim().length).toBeGreaterThan(0)
    } finally {
      app.renderer.destroy()
    }
  })
}

function recordingContext() {
  const claims: Array<{ readonly target: string; readonly placement: string }> = []
  const commands: Array<{ readonly id?: string }> = []
  const pages: string[] = []
  const base = context(fixture)
  const stub = {
    events: { on: () => () => {} },
    status: async () => {
      throw { type: "rpc.unavailable", message: "stub" }
    },
  }
  const proxy = new Proxy(stub, {
    get: (target, property) => {
      if (property in target) return (target as Record<string | symbol, unknown>)[property]
      if (typeof property !== "string") return undefined
      return async () => {
        throw { type: "rpc.unavailable", message: "stub" }
      }
    },
  })
  const value = {
    ...base,
    client: { rpc: () => proxy } as unknown as Context["client"],
    ui: {
      ...base.ui,
      slot: (claim: SlotClaim) => {
        const target = claim.append ?? claim.prepend ?? claim.before ?? claim.after ?? claim.replace
        const placement = claim.append
          ? "append"
          : claim.prepend
            ? "prepend"
            : claim.before
              ? "before"
              : claim.after
                ? "after"
                : "replace"
        claims.push({ target, placement })
        return () => {}
      },
      router: {
        ...base.ui.router,
        register: (page: { readonly name: string }) => {
          pages.push(page.name)
          return () => {}
        },
      },
    },
    keymap: {
      ...base.keymap,
      layer: (factory: () => { readonly commands?: ReadonlyArray<{ readonly id?: string }> }) => {
        commands.push(...(factory().commands ?? []))
      },
    },
  } as unknown as Context
  return { context: value, claims, commands, pages }
}

test("plugin registers additive slots, router pages, and commands", () => {
  const recorded = recordingContext()
  const cleanup = BanyanTui.setup(recorded.context)
  if (typeof cleanup === "function") void cleanup()

  const sidebar = recorded.claims.filter((claim) => claim.target === "sidebar.content")
  expect(sidebar).toHaveLength(10)
  expect(sidebar.every((claim) => claim.placement === "append")).toBe(true)

  expect(recorded.claims.filter((claim) => claim.target === "prompt.footer.status")).toHaveLength(2)
  expect(recorded.claims.filter((claim) => claim.target === "home.footer.status")).toHaveLength(1)
  expect(recorded.claims.filter((claim) => claim.target === "session.composer.top")).toHaveLength(1)
  expect(recorded.claims.filter((claim) => claim.target === "home.bottom")).toHaveLength(1)
  expect(recorded.claims.filter((claim) => claim.target === "session.panel")).toHaveLength(1)

  const ids = recorded.commands.map((command) => command.id)
  expect(ids).toContain("codegraph.build")
  expect(ids).toContain("codegraph.cancel")
  expect(ids).toContain("codegraph.remove")
  expect(ids).toContain("codegraph.force-kill")
  expect(ids).toContain("agent.tree")
  expect(ids).toContain("usage.refresh")
  expect(ids).toContain("agent.model")
  expect(ids).toContain("models.refresh")
  expect(ids).toContain("yolo.toggle")
  expect(ids).toContain("swarm.toggle")
  expect(ids).toContain("subagents.max_subagents")
  expect(ids).toContain("thinking.set")

  expect(recorded.pages).toContain("banyancode.graph")
  expect(recorded.pages).toContain("banyancode.agents")
})

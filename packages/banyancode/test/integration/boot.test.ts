import { expect } from "bun:test"
import { Effect, Exit, Option } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { definitions } from "../../src/agents/definitions.js"
import { TOOL_IDS as CODEGRAPH_TOOL_IDS } from "../../src/codegraph/index.js"
import { INTEL_TOOL_NAMES } from "../../src/intel/index.js"
import { SHARED_MEMORY_TOOL } from "../../src/mesh/shared-memory.js"
import { MESH_TOOL_NAMES } from "../../src/mesh/tools.js"
import plugin from "../../src/server.js"
import { NAME_COMPILE, NAME_LINT, NAME_TEST, NAME_TYPECHECK } from "../../src/verify/index.js"

// The core test harness lives outside this package (banyancode must not depend
// on core in production; core already depends on this plugin). Keep the
// cross-package imports dynamic so the package typecheck program stays scoped
// to banyancode, while `bun test` still loads the real host.
const core = (path: string) => import(["..", "..", "..", "core", path].join("/"))
const { testEffect } = await core("test/lib/effect.js")
const { PluginTestLayer } = await core("test/plugin/fixture.js")
const { Agent } = await core("src/agent.js")
const { Model } = await core("src/model.js")
const { PluginHooks } = await core("src/plugin/hooks.js")
const { PluginHost } = await core("src/plugin/host.js")
const { Provider } = await core("src/provider.js")
const { Rpc } = await core("src/rpc.js")
const { Session } = await core("src/session.js")
const { Tool } = await core("src/tool.js")
const { WebSearch } = await core("src/websearch.js")

/**
 * Boots the real plugin against the real v2 plugin host (the same
 * `PluginTestLayer` + `PluginHost.make` path packages/core/test/plugin uses),
 * then inspects the live registries: every workstream tool, every RPC
 * namespace, every BanyanCode agent and the DuckDuckGo provider.
 *
 * The project database is redirected into a per-test temp directory. The
 * directory is deleted after the plugin scope (and therefore the SQLite
 * handle) closes, so cleanup fails the test if teardown leaks a handle.
 */

const it = testEffect(PluginTestLayer)

const TOOL_IDS = [
  ...new Set([
    ...CODEGRAPH_TOOL_IDS,
    ...Object.values(INTEL_TOOL_NAMES),
    NAME_COMPILE,
    NAME_LINT,
    NAME_TEST,
    NAME_TYPECHECK,
    ...MESH_TOOL_NAMES,
    SHARED_MEMORY_TOOL,
    "banyan_status",
  ]),
]

const RPC_NAMESPACES: ReadonlyArray<{ id: string; method: string; input: unknown }> = [
  { id: "banyancode", method: "status", input: {} },
  { id: "banyancode", method: "config.get", input: {} },
  { id: "banyancode.codegraph", method: "status", input: {} },
  { id: "banyancode.intel", method: "symbols", input: { query: "__banyancode_boot__", limit: 1 } },
  // Invalid input proves the namespace/method exists without spawning a process.
  { id: "banyancode.verify", method: "typecheck", input: { projectRoot: true } },
  { id: "banyancode.mesh", method: "limits.get", input: {} },
  { id: "banyancode.usage", method: "toolUsage", input: {} },
]

it.live(
  "activates every workstream against the real plugin host",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "banyancode-boot-"))),
        (path) =>
          Effect.promise(() => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
      )
      const previous = process.env.BANYANCODE_PROJECT_DB_DIR
      process.env.BANYANCODE_PROJECT_DB_DIR = join(directory, "db")
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.BANYANCODE_PROJECT_DB_DIR
          else process.env.BANYANCODE_PROJECT_DB_DIR = previous
        }),
      )

      const ctx = yield* PluginHost.make({ list: () => Effect.succeed([]) })
      yield* plugin.effect(ctx)

      // ── tools ────────────────────────────────────────────────────────────
      const tools = yield* Tool.Service
      const registered = new Set((yield* tools.list()).map((tool: { id: string }) => tool.id))
      const missing = TOOL_IDS.filter((id) => !registered.has(id))
      expect(missing).toEqual([])

      // ── RPC namespaces ───────────────────────────────────────────────────
      const rpc = yield* Rpc.Service
      for (const entry of RPC_NAMESPACES) {
        const exit = yield* rpc.call(entry.id, entry.method, entry.input).pipe(Effect.exit)
        if (Exit.isFailure(exit)) {
          const failure = Option.getOrUndefined(Exit.findErrorOption(exit)) as { type?: string } | undefined
          expect(failure, `${entry.id}.${entry.method} failed without an RPC failure`).toBeDefined()
          expect(
            ["rpc.unavailable", "rpc.method_not_found"],
            `${entry.id}.${entry.method} did not answer: ${failure?.type}`,
          ).not.toContain(failure!.type)
        }
      }

      // ── agents ───────────────────────────────────────────────────────────
      const agentService = yield* Agent.Service
      const agents = new Map<string, { mode?: string }>()
      for (const agent of (yield* agentService.list()) as Array<{ id: string; mode?: string }>) {
        agents.set(agent.id, agent)
      }
      for (const spec of definitions(5)) {
        expect(agents.has(spec.id), `agent ${spec.id} was not registered`).toBe(true)
      }
      expect(agents.get("orchestrator")?.mode).toBe("primary")
      expect(agents.get("coder")?.mode).toBe("subagent")

      // ── websearch ────────────────────────────────────────────────────────
      const websearch = yield* WebSearch.Service
      const providers = yield* websearch.providers()
      expect(providers.map((provider: { id: string }) => provider.id as string)).toContain("duckduckgo")

      // ── system policy: stable prefix split ───────────────────────────────
      const hooks = yield* PluginHooks.Service
      const policy = yield* hooks.trigger("session", "context", {
        sessionID: Session.ID.make("ses_boot_policy"),
        agent: Agent.ID.make("build"),
        model: Model.Ref.make({ id: Model.ID.make("boot"), providerID: Provider.ID.make("boot") }),
        system: [],
        messages: [],
        options: {},
        tools: {},
      })
      const texts = policy.system.map((part: { text: string }) => part.text)
      expect(texts.some((text: string) => text.includes("Repository intelligence is the canonical interface"))).toBe(
        true,
      )
      expect(texts.some((text: string) => text.includes("BanyanCode orchestration"))).toBe(true)
      // The live graph line is its own part, marked so request assembly moves it behind stable text.
      const graph = policy.system.find((part: { text: string }) => part.text.startsWith("Graph state:"))
      expect(graph?.metadata).toEqual({ system: { volatility: "dynamic" }, banyancode: { source: "codegraph" } })
      const stable = policy.system.find((part: { text: string }) =>
        part.text.includes("Repository intelligence is the canonical interface"),
      )
      expect(stable?.text).not.toContain("Graph state:")

      // ── storage ──────────────────────────────────────────────────────────
      const status = yield* rpc.call("banyancode", "status", {})
      expect(status).toMatchObject({ plugin: "banyancode" })
    }),
  { timeout: 60_000 },
)

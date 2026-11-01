import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import type { Permission } from "@opencode/schema/permission"
import { Provider } from "@opencode/schema/provider"
import { Effect, Stream, type Types } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  apply,
  parseModelRef,
  permissionRules,
  register,
  snapshot,
  type AgentState,
} from "../../src/agents/index.js"
import { BanyanConfig } from "../../src/config/index.js"
import type { Loaded } from "../../src/config/index.js"

type MutableAgent = Types.DeepMutable<Agent.Info>

const makeEditor = () => {
  const agents = new Map<string, MutableAgent>()
  const editor: AgentEditor = {
    list: () => Array.from(agents.values()),
    get: (id) => agents.get(id),
    default: () => {},
    update: (id, update) => {
      const current = agents.get(id) ?? (Agent.Info.default(Agent.ID.make(id)) as MutableAgent)
      if (!agents.has(id)) agents.set(id, current)
      update(current)
      current.id = Agent.ID.make(id)
    },
    remove: (id) => {
      agents.delete(id)
    },
  }
  return { editor, agents }
}

// Same shape as packages/core/src/util/wildcard.ts. The package cannot import
// core (outside its dependency graph), so the matcher is mirrored here.
const wildcard = (input: string, pattern: string) => {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", "s").test(normalized)
}

/** v2 resolves a rule with `findLast` (packages/core/src/permission.ts). */
const lastEffect = (rules: Permission.Ruleset, action: string, resource = "*") =>
  rules.findLast((rule) => wildcard(action, rule.action) && wildcard(resource, rule.resource))?.effect

const state = (overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): AgentState =>
  snapshot(
    { agent: overrides, ...extra } as unknown as Loaded["config"],
    new Map([
      ["test/small", ["low", "high", "max"]],
      ["test/toggle", ["none", "thinking"]],
      ["test/limited", ["high", "max"]],
      ["test/exact", ["low", "medium", "high", "xhigh", "max"]],
    ]),
  )

const materialize = (input: AgentState) => {
  const harness = makeEditor()
  apply(harness.editor, input)
  return harness
}

const ids = [
  "build",
  "plan",
  "explore",
  "coder",
  "scout",
  "reviewer",
  "researcher",
  "orchestrator",
  "compaction",
  "title",
  "summary",
] as const

/** Branded ids do not satisfy `toEqual`'s string overloads; compare plain projections. */
const refOf = (agent: MutableAgent | undefined) =>
  agent?.model === undefined
    ? undefined
    : {
        providerID: agent.model.providerID as string,
        id: agent.model.id as string,
        variant: agent.model.variant as string | undefined,
      }

const variantOf = (agent: MutableAgent | undefined) => agent?.model?.variant as string | undefined

const plainRef = (ref: ReturnType<typeof parseModelRef>) =>
  ref === undefined
    ? undefined
    : { providerID: ref.providerID as string, modelID: ref.modelID as string, variant: ref.variant }

describe("banyancode agents", () => {
  test("registers the full BanyanCode agent set with the expected modes", () => {
    const { agents } = materialize(state({}, { banyancode_max_subagents: 7 }))
    for (const id of ids) expect(agents.has(id)).toBe(true)
    expect(agents.get("build")?.mode).toBe("primary")
    expect(agents.get("plan")?.mode).toBe("primary")
    expect(agents.get("orchestrator")?.mode).toBe("primary")
    expect(agents.get("coder")?.mode).toBe("subagent")
    expect(agents.get("scout")?.mode).toBe("subagent")
    expect(agents.get("reviewer")?.mode).toBe("subagent")
    expect(agents.get("researcher")?.mode).toBe("subagent")
    expect(agents.get("explore")?.mode).toBe("subagent")
    expect(agents.get("compaction")?.hidden).toBe(true)
    expect(agents.get("title")?.hidden).toBe(true)
    expect(agents.get("summary")?.hidden).toBe(true)
  })

  test("loads the ported prompts and renders the subagent cap", () => {
    const { agents } = materialize(state({}, { banyancode_max_subagents: 7 }))
    expect(agents.get("orchestrator")?.system).toContain("orchestrator agent for the BanyanCode mesh")
    expect(agents.get("orchestrator")?.system).toContain("Fan-out cap is 7")
    expect(agents.get("orchestrator")?.system).toContain("Parallelism and tool calls")
    expect(agents.get("coder")?.system).toContain("focused executor")
    expect(agents.get("scout")?.system).toContain("fan-out cap 7")
    expect(agents.get("explore")?.system).toContain("reconnaissance specialist")
    expect(agents.get("researcher")?.system).toContain("Use the `websearch` tool first")
    expect(agents.get("reviewer")?.system).toContain("VERDICT: pass")
    // v1 parity: build/plan keep the provider prompt.
    expect(agents.get("build")?.system).toBeUndefined()
    expect(agents.get("plan")?.system).toBeUndefined()
  })

  test("build allows the four worker subagents and denies the reviewer", () => {
    const { agents } = materialize(state())
    const rules = agents.get("build")!.permissions
    expect(lastEffect(rules, "question")).toBe("allow")
    // v1 `goal` tool stays usable for primary agents.
    expect(lastEffect(rules, "goal")).toBe("allow")
    expect(lastEffect(rules, "subagent", "coder")).toBe("allow")
    expect(lastEffect(rules, "subagent", "explore")).toBe("allow")
    expect(lastEffect(rules, "subagent", "reviewer")).toBe("deny")
    expect(lastEffect(rules, "edit", "src/a.ts")).toBe("allow")
    expect(lastEffect(rules, "read", ".env")).toBe("ask")
    expect(lastEffect(rules, "banyan_change_check")).toBe("allow")
  })

  test("explore, scout and reviewer are read-only after the deny", () => {
    const { agents } = materialize(state())
    for (const id of ["explore", "scout"]) {
      // A read-only subagent never owns a goal loop (v1 explore denied `goal` too).
      expect(lastEffect(agents.get(id)!.permissions, "goal")).toBe("deny")
    }
    for (const id of ["explore", "scout", "reviewer"]) {
      const rules = agents.get(id)!.permissions
      expect(lastEffect(rules, "edit", "src/a.ts")).toBe("deny")
      expect(lastEffect(rules, "shell", "rm -rf build")).toBe("deny")
      expect(lastEffect(rules, "read", "src/a.ts")).toBe("allow")
      expect(lastEffect(rules, "read", ".env")).toBe("ask")
      expect(lastEffect(rules, "repository_query")).toBe("allow")
    }
    expect(lastEffect(agents.get("scout")!.permissions, "todowrite")).toBe("deny")
    expect(lastEffect(agents.get("scout")!.permissions, "websearch")).toBe("allow")
    expect(lastEffect(agents.get("reviewer")!.permissions, "question")).toBe("deny")
    expect(lastEffect(agents.get("reviewer")!.permissions, "websearch")).toBe("deny")
  })

  test("researcher searches but cannot edit or run shell", () => {
    const { agents } = materialize(state())
    const rules = agents.get("researcher")!.permissions
    expect(lastEffect(rules, "edit", "src/a.ts")).toBe("deny")
    expect(lastEffect(rules, "shell")).toBe("deny")
    expect(lastEffect(rules, "websearch")).toBe("allow")
    expect(lastEffect(rules, "webfetch")).toBe("allow")
    expect(lastEffect(rules, "subagent", "coder")).toBe("deny")
  })

  test("coder executes and may only delegate recon to explore/researcher", () => {
    const { agents } = materialize(state())
    const rules = agents.get("coder")!.permissions
    expect(lastEffect(rules, "edit", "src/a.ts")).toBe("allow")
    expect(lastEffect(rules, "shell")).toBe("allow")
    expect(lastEffect(rules, "question")).toBe("allow")
    expect(lastEffect(rules, "subagent", "explore")).toBe("allow")
    expect(lastEffect(rules, "subagent", "researcher")).toBe("allow")
    expect(lastEffect(rules, "subagent", "reviewer")).toBe("deny")
    expect(lastEffect(rules, "read", ".env")).toBe("ask")
  })

  test("orchestrator owns the whole subagent roster", () => {
    const { agents } = materialize(state())
    const rules = agents.get("orchestrator")!.permissions
    for (const child of ["researcher", "coder", "explore", "scout", "reviewer"]) {
      expect(lastEffect(rules, "subagent", child)).toBe("allow")
    }
    expect(lastEffect(rules, "todowrite")).toBe("allow")
    expect(lastEffect(rules, "mesh_control")).toBe("allow")
  })

  test("plan keeps plan files writable while denying everything else", () => {
    const harness = makeEditor()
    // Simulate core's plan plugin, which registers before ours: deny `edit`
    // everywhere, allow only its global plan directory.
    harness.editor.update("plan", (agent) => {
      agent.permissions.push(
        { action: "edit", resource: "*", effect: "deny" },
        { action: "edit", resource: "/global/plan/*", effect: "allow" },
      )
    })
    apply(harness.editor, state())
    const rules = harness.agents.get("plan")!.permissions
    expect(lastEffect(rules, "edit", ".banyancode/plans/step.md")).toBe("allow")
    expect(lastEffect(rules, "edit", ".opencode/plans/step.md")).toBe("allow")
    expect(lastEffect(rules, "edit", "/global/plan/step.md")).toBe("allow")
    expect(lastEffect(rules, "edit", "src/index.ts")).toBe("deny")
    expect(lastEffect(rules, "subagent", "scout")).toBe("allow")
    expect(lastEffect(rules, "subagent", "coder")).toBe("deny")
  })

  test("hidden utility agents stay tool-less except status probes", () => {
    const { agents } = materialize(state())
    for (const id of ["compaction", "title", "summary"]) {
      const rules = agents.get(id)!.permissions
      expect(lastEffect(rules, "read", "src/a.ts")).toBe("deny")
      expect(lastEffect(rules, "codegraph_staleness")).toBe("allow")
      expect(lastEffect(rules, "mesh_status")).toBe("allow")
    }
  })
})

describe("banyancode agent overrides", () => {
  test("model, thinking, prompt, mode and permission overrides apply last", () => {
    const { agents } = materialize(
      state(
        {
          coder: {
            model: "test/small",
            thinking: "high",
            prompt: "CUSTOM CODER PROMPT",
            mode: "primary",
            permission: { shell: "deny", bogus: "nope" },
          },
        },
        { banyancode_max_subagents: 3 },
      ),
    )
    const coder = agents.get("coder")!
    expect(coder.mode).toBe("primary")
    expect(coder.system).toBe("CUSTOM CODER PROMPT")
    expect(refOf(coder)).toEqual({ providerID: "test", id: "small", variant: "high" })
    expect(lastEffect(coder.permissions, "shell")).toBe("deny")
    expect(coder.permissions.some((rule) => rule.action === "bogus")).toBe(false)
  })

  test("thinking maps onto model variants with v1's nearest fallback", () => {
    const { agents } = materialize(
      state({
        coder: { model: "test/small", thinking: "xhigh" },
        scout: { model: "test/limited", thinking: "low" },
        researcher: { model: "test/limited", thinking: "ultra" },
        reviewer: { model: "test/toggle", thinking: "off" },
        orchestrator: { model: "test/exact", thinking: "medium" },
      }),
    )
    expect(variantOf(agents.get("coder"))).toBe("high") // xhigh → strongest available at-or-below
    expect(variantOf(agents.get("scout"))).toBe("high") // low → nearest above when nothing is lower
    expect(variantOf(agents.get("researcher"))).toBe("max") // ultra has no v2 variant
    expect(variantOf(agents.get("reviewer"))).toBe("none") // off → none
    expect(variantOf(agents.get("orchestrator"))).toBe("medium")
  })

  test("an explicit variant wins over thinking and is validated against the catalog", () => {
    const { agents } = materialize(
      state({
        coder: { model: "test/small", thinking: "high", variant: "max" },
        scout: { model: "test/small", variant: "does-not-exist" },
      }),
    )
    expect(variantOf(agents.get("coder"))).toBe("max")
    expect(refOf(agents.get("scout"))).toEqual({ providerID: "test", id: "small", variant: undefined })
  })

  test("model#variant syntax is accepted", () => {
    const { agents } = materialize(state({ coder: { model: "test/small#max", thinking: "low" } }))
    expect(refOf(agents.get("coder"))).toEqual({ providerID: "test", id: "small", variant: "max" })
  })

  test("banyancode_thinking_default applies to subagents with a pinned model", () => {
    const { agents } = materialize(
      state({ coder: { model: "test/small" } }, { banyancode_thinking_default: "high" }),
    )
    expect(variantOf(agents.get("coder"))).toBe("high")
    // Primaries do not inherit the default.
    const { agents: primary } = materialize(
      state({ orchestrator: { model: "test/small" } }, { banyancode_thinking_default: "high" }),
    )
    expect(variantOf(primary.get("orchestrator"))).toBeUndefined()
  })

  test("thinking without a pinned model is stored but cannot reach the model ref", () => {
    const { agents } = materialize(state({ coder: { thinking: "high" } }))
    expect(refOf(agents.get("coder"))).toBeUndefined()
  })

  test("an unresolvable thinking level keeps a variant set by markdown", () => {
    const harness = makeEditor()
    harness.editor.update("reviewer", (agent) => {
      agent.model = { providerID: Provider.ID.make("test"), id: Model.ID.make("unknown"), variant: Model.VariantID.make("high") }
    })
    apply(harness.editor, state({ reviewer: { thinking: "high" } }))
    expect(variantOf(harness.agents.get("reviewer"))).toBe("high")
  })

  test("enabled:false removes subagents but leaves primaries alone", () => {
    const { agents } = materialize(state({ scout: { enabled: false }, build: { enabled: false } }))
    expect(agents.has("scout")).toBe(false)
    expect(agents.has("build")).toBe(true)
  })

  test("mode can be overridden", () => {
    const { agents } = materialize(state({ scout: { mode: "primary" } }))
    expect(agents.get("scout")?.mode).toBe("primary")
  })

  test("a config-only agent is created with v1's mode:all default", () => {
    const { agents } = materialize(state({ "custom-helper": { prompt: "HELP" } }))
    expect(agents.get("custom-helper")?.mode).toBe("all")
    expect(agents.get("custom-helper")?.system).toBe("HELP")
  })

  test("model ref parsing accepts v1 and v2 forms", () => {
    expect(plainRef(parseModelRef("a/b/c"))).toEqual({ providerID: "a", modelID: "b/c", variant: undefined })
    expect(plainRef(parseModelRef("claude-agent/sonnet#high"))).toEqual({
      providerID: "claude-agent",
      modelID: "sonnet",
      variant: "high",
    })
    expect(parseModelRef("noslash")).toBeUndefined()
    expect(parseModelRef("/missing-provider")).toBeUndefined()
    expect(parseModelRef("a/b#")).toBeUndefined()
  })

  test("permission rules drop unknown effects", () => {
    expect(permissionRules({ read: "allow", shell: "deny", weird: "maybe" })).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
    ])
  })
})

describe("banyancode agent registration", () => {
  const withTemp = async (fn: (directory: string) => Promise<void>) => {
    const directory = await mkdtemp(join(tmpdir(), "banyancode-agents-"))
    try {
      await fn(directory)
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }

  test("register applies the definitions and reloads on config.updated", async () => {
    await withTemp(async (directory) => {
      const file = join(directory, "banyancode.json")
      await writeFile(
        file,
        JSON.stringify({
          agent: { coder: { prompt: "OLD" } },
          banyancode_max_goal_iterations: 3,
          banyancode_goal_evaluator_model: "cheap/fast",
        }),
      )
      const config = BanyanConfig.make({ directory, projectRoot: directory, globalDir: join(directory, "missing") })
      const harness = makeEditor()
      let transform: ((editor: AgentEditor) => void) | undefined
      let reloads = 0
      const goalSettings: unknown[] = []
      const ctx = {
        agent: {
          transform: (callback: (editor: AgentEditor) => void) =>
            Effect.sync(() => {
              transform = callback
              callback(harness.editor)
              return { dispose: Effect.void }
            }),
          reload: () =>
            Effect.sync(() => {
              reloads++
              transform?.(harness.editor)
            }),
        },
        model: {
          list: () =>
            Effect.succeed({
              location: {},
              data: [{ providerID: "test", id: "small", variants: [{ id: "high" }] }],
            }),
        },
        event: {
          subscribe: () =>
            Stream.fromEffect(
              Effect.promise(async () => {
                await writeFile(file, JSON.stringify({ agent: { coder: { prompt: "NEW" } } }))
                return { type: "config.updated", data: {} }
              }),
            ),
        },
        // Orchestration policy hook + `goal` tool registration.
        tool: {
          transform: (callback: (editor: { namespace: () => void; add: () => void }) => void) =>
            Effect.sync(() => {
              callback({ namespace: () => {}, add: () => {} })
              return { dispose: Effect.void }
            }),
        },
        session: {
          hook: () => Effect.sync(() => ({ dispose: Effect.void })),
        },
        // The goal plugin client: `register` pushes `banyancode.json`'s goal tuning once per change.
        rpc: Object.assign(
          () => ({
            get: () => Effect.succeed(null),
            configure: (input: unknown) =>
              Effect.sync(() => {
                goalSettings.push(input)
                return input
              }),
          }),
          {
            register: () => Effect.sync(() => ({ dispose: Effect.void, events: { emit: () => Effect.void } })),
          },
        ),
        permission: { assert: () => Effect.void },
      } as unknown as Context

      await Effect.runPromise(
        Effect.scoped(register(ctx, { config }).pipe(Effect.andThen(Effect.sleep("400 millis")))),
      )

      expect(harness.agents.has("coder")).toBe(true)
      expect(harness.agents.get("coder")?.system).toBe("NEW")
      expect(reloads).toBeGreaterThanOrEqual(1)
      // v1's goal keys reach the goal plugin instead of being accepted and ignored.
      expect(goalSettings[0]).toEqual({ maxRounds: 3, evaluatorModel: "cheap/fast" })
      // Dropping a key in the file clears the override, because `configure` replaces the set.
      expect(goalSettings.at(-1)).toEqual({})
    })
  })
})

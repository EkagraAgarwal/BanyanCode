import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { orchestrationText, register } from "../../src/agents/orchestration.js"
import type { Loaded } from "../../src/config/index.js"

const loaded = (values: Record<string, unknown>): Loaded =>
  ({
    config: values,
    sources: [],
    unknownKeys: [],
    errors: [],
  }) as unknown as Loaded

const harness = (config: Record<string, unknown>) => {
  let hook: ((event: { system: Record<string, unknown>[] }) => Effect.Effect<void>) | undefined
  const ctx = {
    session: {
      hook: (_name: string, callback: (event: { system: Record<string, unknown>[] }) => Effect.Effect<void>) =>
        Effect.sync(() => {
          hook = callback
          return { dispose: Effect.void }
        }),
    },
  } as unknown as Context
  return {
    ctx,
    run: async (system: Record<string, unknown>[] = []) => {
      await Effect.runPromise(Effect.scoped(register(ctx, { config: { get: () => Effect.succeed(loaded(config)) } })))
      await Effect.runPromise(hook!({ system }))
      return system
    },
  }
}

describe("orchestration system block (v1 parity)", () => {
  test("renders the v2 tool names and drops memory + bash wording", () => {
    const text = orchestrationText(7)
    expect(text).toContain("Cap: 7 parallel subagents")
    expect(text).toContain("`subagent(background: true)`")
    expect(text).not.toContain("task(background")
    expect(text).not.toContain("memory_store")
    expect(text).not.toContain("memory_recall")
    expect(text).not.toContain("`bash`")
    // Mesh rules that v2 actually implements stay.
    expect(text).toContain("shared_memory")
    expect(text).toContain("subagent_message")
    expect(text).toContain("mesh_subscribe")
  })

  test("appends one stable block for every agent, capped by banyancode_max_subagents", async () => {
    const system: Record<string, unknown>[] = [{ type: "text", text: "agent prompt" }]
    const result = await harness({ banyancode_max_subagents: 4 }).run(system)
    expect(result).toHaveLength(2)
    expect(result[1]!.text).toContain("Cap: 4 parallel subagents")
    expect(result[1]!.metadata).toEqual({ banyancode: { stable: true, source: "orchestration" } })
    // No manual cache hint: it would spend the auto policy's tail breakpoint.
    expect(result[1]!.cache).toBeUndefined()
  })

  test("clamps the subagent cap and ignores the stable-prefix key here", async () => {
    const [part] = await harness({
      banyancode_prompt_cache_stable_prefix: false,
      banyancode_max_subagents: 99,
    }).run()
    expect(part!.cache).toBeUndefined()
    expect(part!.text).toContain("Cap: 20 parallel subagents")
  })
})

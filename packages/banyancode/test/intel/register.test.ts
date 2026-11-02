import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { register as registerIntel } from "../../src/intel/index.js"
import { register as registerVerify } from "../../src/verify/index.js"
import type { Interface as ConfigInterface } from "../../src/config/service.js"
import type { Interface as StorageInterface } from "../../src/storage/service.js"
import { buildTools as buildVerifyTools } from "../../src/verify/tools.js"
import { makeFixture } from "./fixture.js"

/**
 * Exercises the `register(ctx, deps)` wiring: tool registration reaches
 * `ctx.tool.transform` with the exact IDs, and the RPC definitions are handed
 * to `ctx.rpc.register` under the `banyancode.intel` / `banyancode.verify`
 * namespaces. The plugin host is stubbed; the tools, schemas and definitions
 * under test are the real ones.
 */

interface RegisteredRpc {
  readonly definition: { readonly id: string; readonly methods: Readonly<Record<string, unknown>> }
  readonly handlers: Readonly<Record<string, unknown>>
}

const makeContext = (directory: string = process.cwd()) => {
  const tools: Tool.Info[] = []
  const rpc: RegisteredRpc[] = []
  const namespaces: string[] = []
  const commands: string[] = []
  const ctx = {
    app: { name: "banyancode", version: "26.10.9", channel: "dev" },
    location: {
      directory,
      project: { id: "project-1", directory, canonical: directory },
    },
    permission: { assert: () => Effect.void },
    tool: {
      transform: (fn: (editor: unknown) => void) =>
        Effect.sync(() => {
          fn({
            namespace: (value: { name: string }) => {
              namespaces.push(value.name)
            },
            add: (tool: Tool.Info) => {
              tools.push(tool)
            },
          })
        }),
    },
    rpc: {
      register: (definition: RegisteredRpc["definition"], handlers: RegisteredRpc["handlers"]) =>
        Effect.sync(() => {
          rpc.push({ definition, handlers })
          return { dispose: Effect.void, events: { emit: () => Effect.void } }
        }),
    },
    // `/repository-*` command registration added by workstream intel.
    command: {
      transform: (fn: (editor: { add: (definition: { name: string }) => void }) => void) =>
        Effect.sync(() =>
          fn({
            add: (definition) => {
              commands.push(definition.name)
            },
          }),
        ),
    },
    session: { prompt: () => Effect.void },
  }
  return { ctx: ctx as unknown as Context, tools, rpc, namespaces, commands }
}

const codegraph = makeFixture({ files: [], nodes: [], edges: [] }).port
const storage = {} as StorageInterface
const config = {} as ConfigInterface

describe("workstream 3c registration", () => {
  test("intel registers every tool and its RPC namespace", async () => {
    const harness = makeContext()
    await Effect.runPromise(
      Effect.scoped(registerIntel(harness.ctx, { storage, config, codegraph })),
    )

    expect(harness.namespaces).toEqual(["banyan"])
    expect(harness.tools.map((tool) => tool.name).sort()).toEqual(
      [
        "blast_radius",
        "edit_plan",
        "preflight",
        "repository_explain",
        "repository_impact",
        "repository_ownership",
        "repository_query",
        "repository_relationships",
        "repository_symbols",
        "repository_tests",
        "repository_trace",
        "safe_rename",
      ].sort(),
    )
    for (const tool of harness.tools) {
      expect(tool.description.length).toBeGreaterThan(40)
      expect(tool.options?.namespace).toBeUndefined()
      expect(tool.options?.permission).toBe(tool.name)
    }

    expect(harness.commands.sort()).toEqual(
      [
        "repository-query",
        "repository-explain",
        "repository-trace",
        "repository-impact",
        "repository-tests",
        "repository-symbols",
        "repository-relationships",
        "repository-ownership",
      ].sort(),
    )

    expect(harness.rpc.length).toBe(1)
    expect(harness.rpc[0]?.definition.id).toBe("banyancode.intel")
    expect(Object.keys(harness.rpc[0]?.handlers ?? {}).sort()).toEqual(
      Object.keys(harness.rpc[0]?.definition.methods ?? {}).sort(),
    )
  })

  test("verify registers the four tools and its RPC namespace", async () => {
    const harness = makeContext()
    await Effect.runPromise(Effect.scoped(registerVerify(harness.ctx, { storage, config, codegraph })))

    expect(harness.tools.map((tool) => tool.name).sort()).toEqual([
      "banyan_compile",
      "banyan_lint",
      "banyan_test",
      "banyan_typecheck",
    ])
    expect(harness.rpc.length).toBe(1)
    expect(harness.rpc[0]?.definition.id).toBe("banyancode.verify")
    expect(Object.keys(harness.rpc[0]?.definition.methods).sort()).toEqual(["lint", "test", "typecheck"])
  })

  test("verify tool rejects a path that escapes the project root before spawning", async () => {
    const harness = makeContext()
    await Effect.runPromise(Effect.scoped(registerVerify(harness.ctx, { storage, config, codegraph })))
    const tool = harness.tools.find((candidate) => candidate.name === "banyan_test")
    expect(tool).toBeDefined()

    const toolContext = {
      sessionID: "session-1",
      agent: "coder",
      messageID: "message-1",
      id: "call-1",
      progress: () => Effect.void,
    }
    const exit = await Effect.runPromiseExit(
      tool!.execute({ path: "../outside.test.ts", projectRoot: process.cwd() }, toolContext as never),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("resolves outside projectRoot")
    }
  })

  test("every verify tool carries an input schema and permission action", () => {
    const harness = makeContext()
    const verifier = {
      detect: () => Effect.die("unused"),
      typecheck: () => Effect.die("unused"),
      test: () => Effect.die("unused"),
      lint: () => Effect.die("unused"),
      compile: () => Effect.die("unused"),
    }
    const tools = buildVerifyTools(harness.ctx, verifier)
    for (const tool of tools) {
      expect(tool.input).toBeDefined()
      expect(tool.options?.permission).toBe(tool.name)
    }
  })

  test("verify tools default to the location project root, not the process cwd", async () => {
    const directory = join(tmpdir(), "banyancode-verify-location")
    const harness = makeContext(directory)
    const roots: string[] = []
    const result = {
      kind: "test" as const,
      target: "src/sum.test.ts",
      status: "passed" as const,
      summary: { passed: 1, failed: 0, skipped: 0 },
      durationMs: 1,
      cacheHit: false,
      rawOutput: "pass",
      command: "bun test src/sum.test.ts",
    }
    const verifier = {
      detect: () => Effect.die("unused"),
      typecheck: () => Effect.die("unused"),
      test: (input: { projectRoot?: string }) =>
        Effect.sync(() => {
          roots.push(input.projectRoot ?? "")
          return result
        }),
      lint: () => Effect.die("unused"),
      compile: () => Effect.die("unused"),
    }
    const tool = buildVerifyTools(harness.ctx, verifier as never).find(
      (candidate) => candidate.name === "banyan_test",
    )!
    await Effect.runPromise(
      tool.execute(
        { path: "src/sum.test.ts" },
        {
          sessionID: "session-1",
          agent: "coder",
          messageID: "message-1",
          id: "call-1",
          progress: () => Effect.void,
        } as never,
      ),
    )
    expect(roots).toEqual([directory])
  })
})

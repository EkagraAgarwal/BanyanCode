import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Effect } from "effect"
import type { Permission } from "@opencode/schema/permission"
import * as Gateway from "../../src/gateway/gateway.js"
import type { GatewayProbe, ProbeResult } from "../../src/gateway/types.js"
import type { Storage } from "../../src/storage/index.js"
import type { Harness, HarnessOptions } from "./harness.js"
import { callHook, configFor, makeContext, withStorage, withTemp } from "./harness.js"

/**
 * The hook contract: `execute.before` rewrites, `execute.after` stamps
 * `metadata.gateway`, appends the escape hatch, and records the ledger row.
 * The graph is a stub here; `integration.test.ts` runs the real probe, tools
 * and database.
 */

const FRESH: ProbeResult = { graphBuilt: true, stale: false }

const probeOf = (result: Partial<ProbeResult>): GatewayProbe => ({
  probe: () => Effect.succeed({ ...FRESH, ...result }),
  augmentRead: ({ path }) => Effect.succeed(`Symbol: ${path} | Imports: 0 | References: 0 | Callers: 0 | Dependents: 0`),
})

const before = (tool: string, input: Record<string, unknown>, id = "call-1") => ({
  tool,
  sessionID: "ses_test",
  agent: "build",
  messageID: "msg_1",
  id,
  input,
})

const completed = (tool: string, input: Record<string, unknown>, content: string, id = "call-1") => ({
  tool,
  sessionID: "ses_test",
  agent: "build",
  messageID: "msg_1",
  id,
  status: "completed" as const,
  input,
  result: { content, metadata: { truncated: false } },
})

const withGateway = async (
  directory: string,
  values: Record<string, unknown>,
  probe: GatewayProbe | undefined,
  body: (harness: Harness, storage: Storage.Interface) => Promise<void>,
  options: HarnessOptions = {},
  availableTools?: ReadonlySet<string>,
): Promise<void> => {
  const config = await configFor(directory, values)
  const harness = makeContext(directory, options)
  await withStorage(directory, (storage) =>
    Effect.gen(function* () {
      yield* Gateway.register(harness.ctx, {
        storage,
        config,
        ...(probe === undefined ? {} : { codegraph: probe }),
        ...(availableTools === undefined ? {} : { availableTools }),
      })
      yield* Effect.tryPromise(() => body(harness, storage)).pipe(Effect.orDie)
    }),
  ).pipe(Effect.runPromise)
}

const usageRows = (storage: Storage.Interface) =>
  Effect.runPromise(
    storage.query<{ from_tool: string; to_tool: string; route: string; use_count: number; bytes_saved: number }>(
      "SELECT from_tool, to_tool, route, use_count, bytes_saved FROM gateway_usage ORDER BY route",
    ),
  )

describe("gateway execute hooks", () => {
  test("an identifier grep swaps to code_find usages, is stamped, and counted", async () => {
    await withTemp(async (directory) => {
      await withGateway(directory, { banyancode_router_trace: true }, probeOf({ symbolHits: 2 }), async (harness, storage) => {
        const event = before("grep", { pattern: "AuthManager" })
        await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))
        expect(event.tool).toBe("code_find")
        expect(event.input).toEqual({ intent: "usages", target: "AuthManager" })

        const after = completed("code_find", event.input, "Usages (1):\nfunction handleRequest (src/a.ts:1-2)")
        await Effect.runPromise(callHook(harness.tool.get("execute.after"), after))
        expect(after.result.content).toEndWith(
          "[gateway: grep -> code_find (usages). Comments and strings are not included. Repeat this grep for raw text.]",
        )
        expect(after.result.metadata).toMatchObject({
          codegraph: true,
          gateway: { route: "swapped", from: "grep", to: "code_find", op: "usages", reason: "identifier" },
        })
        expect(await usageRows(storage)).toEqual([
          { from_tool: "grep", to_tool: "code_find", route: "swapped", use_count: 1, bytes_saved: 0 },
        ])

        const trace = await Bun.file(join(directory, ".banyancode", "trace", "ses_test.jsonl")).text()
        expect(JSON.parse(trace.trim())).toMatchObject({
          event: "repository_route",
          originalTool: "grep",
          route: "swap",
          to: "code_find",
          op: "usages",
          reason: "identifier",
          graphBuilt: true,
          graphStale: false,
        })
      })
    })
  })

  test("an unbuilt graph falls back, runs grep, and says why", async () => {
    await withTemp(async (directory) => {
      await withGateway(directory, {}, probeOf({ graphBuilt: false, stale: true }), async (harness, storage) => {
        const event = before("grep", { pattern: "AuthManager" })
        await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))
        expect(event.tool).toBe("grep")

        const after = completed("grep", event.input, "No matches found")
        await Effect.runPromise(callHook(harness.tool.get("execute.after"), after))
        expect(after.result.content).toBe("No matches found")
        expect(after.result.metadata).toMatchObject({
          gateway: { route: "fallback", from: "grep", reason: "graph-unbuilt" },
        })
        expect(after.result.metadata).not.toHaveProperty("codegraph")
        expect(await usageRows(storage)).toEqual([
          { from_tool: "grep", to_tool: "", route: "fallback", use_count: 1, bytes_saved: 0 },
        ])
      })
    })
  })

  test("a large whole-file read swaps to outline and reports saved bytes", async () => {
    await withTemp(async (directory) => {
      await withGateway(
        directory,
        {},
        probeOf({ indexed: true, fileStale: false, lines: 900, bytes: 4_000 }),
        async (harness, storage) => {
          const event = before("read", { path: "src/app.ts" })
          await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))
          expect(event.tool).toBe("repo")
          expect(event.input).toEqual({ op: "outline", path: "src/app.ts" })

          const outline = "Symbol: App | Imports: 1 | References: 2 | Callers: 0 | Dependents: 0\nsymbols (1)"
          const after = completed("repo", event.input, outline)
          await Effect.runPromise(callHook(harness.tool.get("execute.after"), after))
          expect(after.result.metadata).toMatchObject({
            gateway: { route: "swapped", from: "read", to: "repo", op: "outline", bytesSaved: 4_000 - outline.length },
          })
          expect(after.result.content).toEndWith("[gateway: read -> repo (outline). Symbols only, not the file body. Repeat this read for raw text.]")
          expect(await usageRows(storage)).toEqual([
            {
              from_tool: "read",
              to_tool: "repo",
              route: "swapped",
              use_count: 1,
              bytes_saved: 4_000 - outline.length,
            },
          ])
        },
      )
    })
  })

  test("a read the agent may not make freely is never swapped to an outline", async () => {
    await withTemp(async (directory) => {
      await withGateway(
        directory,
        {},
        probeOf({ indexed: true, fileStale: false, lines: 900, bytes: 4_000 }),
        async (harness) => {
          const event = before("read", { path: "src/secret.ts" })
          await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))
          expect(event.tool).toBe("read")
          expect(event.input).toEqual({ path: "src/secret.ts" })
        },
        { permissions: [{ action: "read", resource: "src/secret*", effect: "ask" }] },
      )
    })
  })

  test("a small file is a real read with the symbol header", async () => {
    await withTemp(async (directory) => {
      await withGateway(directory, {}, probeOf({ indexed: true, fileStale: false, lines: 20, bytes: 800 }), async (harness) => {
        const event = before("read", { path: "src/app.ts" })
        await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))
        expect(event.tool).toBe("read")

        const after = completed("read", event.input, "Read file src/app.ts, lines 1-2\n1: a")
        await Effect.runPromise(callHook(harness.tool.get("execute.after"), after))
        expect(after.result.content).toStartWith("Symbol: src/app.ts | Imports: 0")
        expect(after.result.metadata).toMatchObject({
          codegraph: true,
          gateway: { route: "augmented", from: "read", reason: "symbol-header" },
        })
      })
    })
  })

  test("repeating a swapped call runs the real tool", async () => {
    await withTemp(async (directory) => {
      await withGateway(directory, {}, probeOf({ symbolHits: 2 }), async (harness) => {
        const first = before("grep", { pattern: "AuthManager" }, "call-1")
        await Effect.runPromise(callHook(harness.tool.get("execute.before"), first))
        expect(first.tool).toBe("code_find")
        await Effect.runPromise(
          callHook(harness.tool.get("execute.after"), completed("code_find", first.input, "Usages: none.", "call-1")),
        )

        const second = before("grep", { pattern: "AuthManager" }, "call-2")
        await Effect.runPromise(callHook(harness.tool.get("execute.before"), second))
        expect(second.tool).toBe("grep")
        const after = completed("grep", second.input, "src/a.ts:1: AuthManager", "call-2")
        await Effect.runPromise(callHook(harness.tool.get("execute.after"), after))
        expect(after.result.metadata).toMatchObject({ gateway: { route: "direct", from: "grep", reason: "repeat" } })
        expect(after.result.content).toBe("src/a.ts:1: AuthManager")
      })
    })
  })

  test("a swapped tool that errors says how to get the raw result, and the repeat is direct", async () => {
    await withTemp(async (directory) => {
      await withGateway(directory, {}, probeOf({ symbolHits: 2 }), async (harness) => {
        const event = before("grep", { pattern: "AuthManager" }, "call-1")
        await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))
        const failed = {
          tool: "code_find",
          sessionID: "ses_test",
          agent: "build",
          messageID: "msg_1",
          id: "call-1",
          status: "error" as const,
          input: event.input,
          error: Object.assign(new Error("code_find exploded"), { metadata: undefined }),
        }
        await Effect.runPromise(callHook(harness.tool.get("execute.after"), failed))
        expect(failed.error.message).toContain("[gateway: this grep was swapped to code_find and failed. Repeat this grep to run the real tool.]")
        expect((failed.error as { metadata?: Record<string, unknown> }).metadata).toMatchObject({
          gateway: { route: "swapped", from: "grep", to: "code_find" },
        })

        const repeat = before("grep", { pattern: "AuthManager" }, "call-2")
        await Effect.runPromise(callHook(harness.tool.get("execute.before"), repeat))
        expect(repeat.tool).toBe("grep")
      })
    })
  })

  test("a read outside the project root always runs the real read", async () => {
    await withTemp(async (directory) => {
      await withGateway(directory, {}, probeOf({ indexed: true, fileStale: false, lines: 900, bytes: 4_000 }), async (harness) => {
        const event = before("read", { path: "D:/somewhere-else/app.ts" })
        await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))
        expect(event.tool).toBe("read")
        const after = completed("read", event.input, "Read file D:/somewhere-else/app.ts, lines 1-9")
        await Effect.runPromise(callHook(harness.tool.get("execute.after"), after))
        expect(after.result.metadata).toMatchObject({
          gateway: { route: "direct", from: "read", reason: "outside-project" },
        })
      })
    })
  })

  test("the router kill switch and per-tool opt-outs leave the call untouched", async () => {
    await withTemp(async (directory) => {
      await withGateway(directory, { banyancode_router: "off" }, probeOf({ symbolHits: 2 }), async (harness) => {
        const event = before("grep", { pattern: "AuthManager" })
        await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))
        expect(event.tool).toBe("grep")
        const after = completed("grep", event.input, "No matches found")
        await Effect.runPromise(callHook(harness.tool.get("execute.after"), after))
        expect(after.result.metadata).toEqual({ truncated: false })
      })
    })
    await withTemp(async (directory) => {
      await withGateway(directory, { banyancode_route_grep: false }, probeOf({ symbolHits: 2 }), async (harness) => {
        const event = before("grep", { pattern: "AuthManager" })
        await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))
        expect(event.tool).toBe("grep")
      })
    })
  })

  test("a rewrite the agent lacks permission for falls back", async () => {
    await withTemp(async (directory) => {
      const permissions: Permission.Ruleset = [
        { action: "*", resource: "*", effect: "allow" },
        { action: "code_find", resource: "*", effect: "deny" },
      ]
      await withGateway(
        directory,
        {},
        probeOf({ symbolHits: 2 }),
        async (harness) => {
          const event = before("grep", { pattern: "AuthManager" })
          await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))
          expect(event.tool).toBe("grep")
        },
        { permissions },
      )
    })
  })

  test("a host refusal records fallback, never swapped", async () => {
    await withTemp(async (directory) => {
      await withGateway(directory, {}, probeOf({ symbolHits: 2 }), async (harness) => {
        const event = before("grep", { pattern: "AuthManager" })
        await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))
        // The host decided the request cannot run code_find and ran the original.
        const after = completed("grep", event.input, "No matches found")
        await Effect.runPromise(callHook(harness.tool.get("execute.after"), after))
        expect(after.result.metadata).toMatchObject({
          gateway: { route: "fallback", from: "grep", reason: "rewrite-refused" },
        })
        expect(after.result.metadata).not.toHaveProperty("codegraph")
      })
    })
  })

  test("an original tool that failed after a refused rewrite stays a plain failure", async () => {
    await withTemp(async (directory) => {
      await withGateway(directory, {}, probeOf({ symbolHits: 2 }), async (harness) => {
        const event = before("grep", { pattern: "AuthManager" })
        await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))
        const failed = {
          tool: "grep",
          sessionID: "ses_test",
          agent: "build",
          messageID: "msg_1",
          id: "call-1",
          status: "error" as const,
          input: event.input,
          error: Object.assign(new Error("grep exploded"), { metadata: undefined }),
        }
        await Effect.runPromise(callHook(harness.tool.get("execute.after"), failed))
        expect(failed.error.message).not.toContain("gateway")
        expect((failed.error as { metadata?: Record<string, unknown> }).metadata).toMatchObject({
          gateway: { route: "fallback", reason: "rewrite-refused" },
        })
      })
    })
  })
})

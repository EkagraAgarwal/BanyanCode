import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Effect } from "effect"
import * as Gateway from "../../src/gateway/gateway.js"
import type { CodegraphQuery } from "../../src/gateway/types.js"
import { callHook, configFor, makeContext, withStorage, withTemp } from "./harness.js"

const setup = async (
  directory: string,
  values: Record<string, unknown>,
  codegraph?: CodegraphQuery,
) => {
  const config = await configFor(directory, { banyancode_router_trace: true, ...values })
  const harness = makeContext(directory)
  await withStorage(directory, (storage) =>
    Gateway.register(harness.ctx, { storage, config, ...(codegraph === undefined ? {} : { codegraph }) }),
  ).pipe(Effect.runPromise)
  return harness
}

const beforeEvent = (tool: string, input: Record<string, unknown>, id = "call-1") => ({
  tool,
  sessionID: "ses_test",
  agent: "build",
  messageID: "msg_1",
  id,
  input,
})

const traceLines = async (directory: string): Promise<Record<string, unknown>[]> => {
  const file = Bun.file(join(directory, ".banyancode", "trace", "ses_test.jsonl"))
  if (!(await file.exists())) return []
  return (await file.text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("gateway tool hooks", () => {
  test("grep relationship language rewrites to a codegraph tool and traces the route", async () => {
    await withTemp(async (directory) => {
      const codegraph: CodegraphQuery = {
        route: ({ operation }) =>
          Effect.succeed(
            operation.kind === "relationship"
              ? { tool: "code_find", input: { intent: operation.relation, target: operation.target } }
              : undefined,
          ),
      }
      const harness = await setup(directory, {}, codegraph)
      const event = beforeEvent("grep", { pattern: "who calls AuthManager" })
      await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))

      expect(event.tool).toBe("code_find")
      expect(event.input).toEqual({ intent: "callers", target: "AuthManager" })
      const traces = await traceLines(directory)
      expect(traces).toHaveLength(1)
      expect(traces[0]).toMatchObject({
        event: "repository_route",
        originalTool: "grep",
        route: "intelligence",
        backend: "codegraph",
        router: "rules",
        routerVersion: "0.1.0",
        graphFreshness: "unavailable",
      })
    })
  })

  test("router off keeps the original call and emits a noop trace", async () => {
    await withTemp(async (directory) => {
      const harness = await setup(directory, { banyancode_router: "off" }, {
        route: () => Effect.succeed({ tool: "code_find", input: {} }),
      })
      const event = beforeEvent("grep", { pattern: "who calls AuthManager" })
      await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))
      expect(event.tool).toBe("grep")
      expect(event.input).toEqual({ pattern: "who calls AuthManager" })
      const traces = await traceLines(directory)
      expect(traces[0]).toMatchObject({ route: "direct", backend: "filesystem", router: "noop", routerVersion: "0" })
    })
  })

  test("route_grep false bypasses the gateway entirely", async () => {
    await withTemp(async (directory) => {
      const harness = await setup(directory, { banyancode_route_grep: false }, {
        route: () => Effect.succeed({ tool: "code_find", input: {} }),
      })
      const event = beforeEvent("grep", { pattern: "who calls AuthManager" })
      await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))
      expect(event.tool).toBe("grep")
      expect(await traceLines(directory)).toEqual([])
    })
  })

  test("read augmentation prepends the compact symbol header after the read", async () => {
    await withTemp(async (directory) => {
      const header = "Symbol: AuthManager | Imports: 2 | References: 7 | Callers: 3 | Dependents: 1"
      const harness = await setup(directory, {}, {
        augmentRead: () => Effect.succeed(header),
      })
      const before = beforeEvent("read", { path: "src/auth/AuthManager.ts" })
      await Effect.runPromise(callHook(harness.tool.get("execute.before"), before))
      expect(before.tool).toBe("read")

      const result: {
        content?: unknown
        output?: { type?: string; content?: string }
        metadata?: Record<string, unknown>
      } = {
        content: "1: export class AuthManager {}",
        output: { type: "text-page", content: "1: export class AuthManager {}" },
      }
      const after = {
        tool: "read",
        sessionID: "ses_test",
        agent: "build",
        messageID: "msg_1",
        id: "call-1",
        status: "completed",
        input: { path: "src/auth/AuthManager.ts" },
        result,
      }
      await Effect.runPromise(callHook(harness.tool.get("execute.after"), after))

      expect(after.result.content).toBe(`${header}\n1: export class AuthManager {}`)
      expect(after.result.output?.content).toBe(`${header}\n1: export class AuthManager {}`)
      expect(after.result.metadata).toEqual({ codegraph: true })
      const traces = await traceLines(directory)
      expect(traces[0]).toMatchObject({ route: "augment", backend: "codegraph" })
    })
  })

  test("augment is a no-op without a codegraph adapter", async () => {
    await withTemp(async (directory) => {
      const harness = await setup(directory, {})
      const before = beforeEvent("read", { path: "src/auth/AuthManager.ts" })
      await Effect.runPromise(callHook(harness.tool.get("execute.before"), before))
      const result: { content?: unknown; metadata?: Record<string, unknown> } = { content: "1: code" }
      const after = {
        tool: "read",
        sessionID: "ses_test",
        agent: "build",
        messageID: "msg_1",
        id: "call-1",
        status: "completed",
        input: { path: "src/auth/AuthManager.ts" },
        result,
      }
      await Effect.runPromise(callHook(harness.tool.get("execute.after"), after))
      expect(after.result.content).toBe("1: code")
      expect(after.result.metadata).toBeUndefined()
      const traces = await traceLines(directory)
      expect(traces[0]).toMatchObject({ route: "direct", backend: "filesystem" })
    })
  })

  test("intelligence falls through when the codegraph adapter declines", async () => {
    await withTemp(async (directory) => {
      const harness = await setup(directory, {}, { route: () => Effect.succeed(undefined) })
      const event = beforeEvent("grep", { pattern: "who calls AuthManager" })
      await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))
      expect(event.tool).toBe("grep")
      const traces = await traceLines(directory)
      expect(traces[0]).toMatchObject({ route: "direct", backend: "filesystem" })
    })
  })

  test("gate B supplies the last user request to the router", async () => {
    await withTemp(async (directory) => {
      const harness = await setup(directory, {}, {
        route: ({ operation }) => Effect.succeed({ tool: "code_find", input: { operation } }),
      })
      harness.setMessages([
        { type: "user", text: "please find the callers of AuthManager" },
      ])
      const event = beforeEvent("grep", { pattern: "AuthManager" })
      await Effect.runPromise(callHook(harness.tool.get("execute.before"), event))
      expect(event.tool).toBe("code_find")
    })
  })
})

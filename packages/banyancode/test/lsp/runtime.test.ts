import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Effect } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { BanyanConfig } from "../../src/config/index.js"
import * as LSPClient from "../../src/lsp/client.js"
import { resolveConfig } from "../../src/lsp/config.js"
import { create } from "../../src/lsp/manager.js"
import { makeLspTool } from "../../src/lsp/tools.js"
import { spawn } from "../../src/lsp/process.js"
import { register } from "../../src/lsp/index.js"
import { lspStatus } from "../../src/system/lsp.js"
import type { Storage } from "../../src/storage/index.js"
import { alive, cleanup, configFile, fixtureCommand, pidFromFile, tempDir, waitFor, write } from "./harness.js"

const instanceOf = (directory: string) => ({ directory, worktree: directory })

describe("lsp client", () => {
  test("spawns a real stdio server, opens a document, and reports diagnostics", async () => {
    const directory = await tempDir("client")
    const pidFile = join(directory, "server.pid")
    const target = join(directory, "sample.fixture")
    await write(target, "BAD token\n")
    const child = spawn(fixtureCommand(pidFile), { cwd: directory })
    try {
      const client = await LSPClient.create({
        serverID: "fixture",
        server: { process: child },
        root: directory,
        directory,
      })
      const version = await client.notify.open({ path: target })
      expect(version).toBe(0)
      await client.waitForDiagnostics({ path: target, version, mode: "document" })
      const diagnostics = [...client.diagnostics.values()].flat()
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.severity).toBe(1)
      expect(diagnostics[0]?.message).toBe("fixture: BAD token found")

      const initialization = await client.connection.request<{ initializationOptions: unknown }>("fixture/initialization")
      expect(initialization.initializationOptions).toEqual({})

      const documents = await client.connection.request<{ path: string; version: number }[]>("fixture/documents")
      expect(documents.some((document) => document.path.replaceAll("\\", "/").endsWith("sample.fixture"))).toBe(true)

      const pid = await pidFromFile(pidFile)
      await client.shutdown()
      await waitFor(() => !alive(pid), { timeoutMs: 5_000 })
    } finally {
      await cleanup(directory)
    }
  })
})

describe("lsp manager", () => {
  test("idle shutdown kills the language server process", async () => {
    const directory = await tempDir("idle")
    const pidFile = join(directory, "server.pid")
    const target = join(directory, "sample.fixture")
    await write(target, "clean\n")
    const config = resolveConfig({
      banyan: { fixture: { command: fixtureCommand(pidFile), extensions: [".fixture"] } },
      banyanIdleTimeoutMs: 100,
    })
    const manager = create({
      instance: instanceOf(directory),
      resolve: async () => config,
      sweepIntervalMs: 50,
    })
    try {
      await manager.touch(target, "document")
      const pid = await pidFromFile(pidFile)
      expect(manager.status().servers.find((server) => server.id === "fixture")?.status).toBe("connected")
      expect(manager.status().servers.find((server) => server.id === "fixture")?.pid).toBe(pid)

      await waitFor(() => manager.status().servers.every((server) => server.status !== "connected"), {
        timeoutMs: 5_000,
      })
      await waitFor(() => !alive(pid), { timeoutMs: 5_000 })
    } finally {
      await manager.dispose()
      await cleanup(directory)
    }
  })

  test("a config reload detaches clients when LSP is turned off", async () => {
    const directory = await tempDir("toggle")
    const pidFile = join(directory, "server.pid")
    const target = join(directory, "sample.fixture")
    await write(target, "clean\n")
    let current = resolveConfig({
      banyan: { fixture: { command: fixtureCommand(pidFile), extensions: [".fixture"] } },
      banyanIdleTimeoutMs: 60_000,
    })
    const manager = create({
      instance: instanceOf(directory),
      resolve: async () => current,
      reloadIntervalMs: 0,
    })
    try {
      await manager.touch(target, "document")
      const pid = await pidFromFile(pidFile)
      expect(manager.enabled()).toBe(true)

      current = resolveConfig({ banyan: false })
      await manager.touch(target, "document")
      expect(manager.enabled()).toBe(false)
      expect(manager.status().servers).toEqual([])
      await waitFor(() => !alive(pid), { timeoutMs: 5_000 })
    } finally {
      await manager.dispose()
      await cleanup(directory)
    }
  })

  test("the lsp tool queries the attached server", async () => {
    const directory = await tempDir("tool")
    const pidFile = join(directory, "server.pid")
    const target = join(directory, "sample.fixture")
    await write(target, "clean\n")
    const config = resolveConfig({
      banyan: { fixture: { command: fixtureCommand(pidFile), extensions: [".fixture"] } },
      banyanIdleTimeoutMs: 60_000,
    })
    const manager = create({ instance: instanceOf(directory), resolve: async () => config })
    try {
      const tool = makeLspTool({
        ctx: { permission: { assert: () => Effect.void } } as unknown as Context,
        manager,
      })
      const context = {
        sessionID: "session-1",
        agent: "build",
        messageID: "message-1",
        id: "call-1",
        progress: () => Effect.void,
      } as unknown as Tool.Context
      const result = await Effect.runPromise(
        tool.execute({ operation: "hover", filePath: target, line: 1, character: 1 }, context),
      )
      expect(JSON.stringify(result.output)).toContain("fixture hover")
      const symbols = await Effect.runPromise(
        tool.execute({ operation: "workspaceSymbol", filePath: target, line: 1, character: 1, query: "fixture" }, context),
      )
      expect(JSON.stringify(symbols.output)).toContain("fixture:fixture")
      expect(JSON.stringify(symbols.output)).not.toContain("wrongKind")
    } finally {
      await manager.dispose()
      await cleanup(directory)
    }
  })

  test("status marks configured servers and reports disabled entries", async () => {
    const directory = await tempDir("status")
    const config = resolveConfig({
      banyan: {
        fixture: { command: ["fixture-bin"], extensions: [".fixture"] },
        typescript: { disabled: true },
      },
    })
    const manager = create({ instance: instanceOf(directory), resolve: async () => config })
    try {
      await manager.reload()
      const status = manager.status()
      expect(status.enabled).toBe(true)
      expect(status.servers.find((server) => server.id === "fixture")).toMatchObject({
        status: "configured",
        inert: true,
      })
      expect(status.servers.find((server) => server.id === "typescript")).toMatchObject({
        status: "configured",
        disabled: true,
        disabledReason: "disabled in banyancode.json",
      })
    } finally {
      await manager.dispose()
      await cleanup(directory)
    }
  })
})

describe("lsp register", () => {
  test("execute.after appends v1 diagnostics and scope close leaves no server process", async () => {
    const directory = await tempDir("register")
    const pidFile = join(directory, "server.pid")
    const command = fixtureCommand(pidFile)
    await configFile(directory, command)
    const target = join(directory, "sample.fixture")
    await write(target, "BAD WARN\n")

    const tools: Tool.Info[] = []
    const hooks = new Map<string, (event: any) => Effect.Effect<void>>()
    const ctx = {
      app: { name: "banyancode", version: "0.0.0", channel: "local" },
      location: { directory, project: { canonical: directory, directory, id: "project-1" } },
      tool: {
        transform: (fn: (editor: unknown) => void) =>
          Effect.sync(() => {
            fn({
              namespace: () => {},
              add: (tool: Tool.Info) => {
                tools.push(tool)
              },
            })
          }),
        hook: (name: string, callback: (event: any) => Effect.Effect<void>) =>
          Effect.sync(() => {
            hooks.set(name, callback)
            return { dispose: Effect.void }
          }),
        list: () => Effect.succeed(tools),
      },
      permission: { assert: () => Effect.void },
    } as unknown as Context

    const previous = process.env.BANYANCODE_EXPERIMENTAL_LSP_TOOL
    process.env.BANYANCODE_EXPERIMENTAL_LSP_TOOL = "1"
    try {
      const config = BanyanConfig.make({ directory, projectRoot: directory, globalDir: directory })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* register(ctx, { storage: {} as Storage.Interface, config })
            expect(tools.map((tool) => tool.name)).toContain("lsp")
            const hook = hooks.get("execute.after")
            expect(hook).toBeDefined()

            const event = {
              tool: "edit",
              sessionID: "session-1",
              agent: "build",
              messageID: "message-1",
              id: "call-1",
              input: { path: target },
              status: "completed" as const,
              result: { content: "Edited sample.fixture (1 replacement)" },
            }
            yield* hook!(event)

            expect(event.result.content).toBe(
              [
                "Edited sample.fixture (1 replacement)",
                "",
                "LSP errors detected in this file, please fix:",
                `<diagnostics file="${target}">`,
                "ERROR [1:1] fixture: BAD token found",
                "</diagnostics>",
              ].join("\n"),
            )

            const status = lspStatus({ banyancode_lsp: true })
            expect(status.enabled).toBe(true)
            expect(status.servers.find((server) => server.id === "fixture")?.status).toBe("connected")

            // Warnings alone never produce a block (v1 filters severity 1).
            const clean = join(directory, "clean.fixture")
            yield* Effect.promise(() => write(clean, "WARN only\n"))
            const warnEvent = {
              tool: "edit",
              sessionID: "session-1",
              agent: "build",
              messageID: "message-2",
              id: "call-2",
              input: { path: clean },
              status: "completed" as const,
              result: { content: "Edited clean.fixture (1 replacement)" },
            }
            yield* hook!(warnEvent)
            expect(warnEvent.result.content).toBe("Edited clean.fixture (1 replacement)")

            const patchEvent = {
              tool: "patch",
              sessionID: "session-1",
              agent: "build",
              messageID: "message-3",
              id: "call-3",
              input: { patchText: "*** Begin Patch" },
              status: "completed" as const,
              result: {
                content: "Success. Updated the following files:\nM sample.fixture",
                output: { applied: [{ type: "update", resource: "sample.fixture", target }] },
              },
            }
            yield* hook!(patchEvent)
            expect(patchEvent.result.content).toContain(
              `LSP errors detected in sample.fixture, please fix:\n<diagnostics file="${target}">`,
            )

            const pid = yield* Effect.promise(() => pidFromFile(pidFile))
            expect(alive(pid)).toBe(true)
          }),
        ),
      )
      const pid = await pidFromFile(pidFile)
      await waitFor(() => !alive(pid), { timeoutMs: 5_000 })
    } finally {
      if (previous === undefined) delete process.env.BANYANCODE_EXPERIMENTAL_LSP_TOOL
      else process.env.BANYANCODE_EXPERIMENTAL_LSP_TOOL = previous
      await cleanup(directory)
    }
  })
})

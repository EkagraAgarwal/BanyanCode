import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { resolveConfig, resolveFlags, readHostLsp, coerceSetting } from "../../src/lsp/config.js"
import { stop } from "../../src/lsp/process.js"
import { cleanup, fixtureCommand, tempDir, write } from "./harness.js"

const builtinIds = (servers: Record<string, { id: string }>) => Object.keys(servers)

describe("lsp config", () => {
  test("banyancode_lsp=true enables the built-ins with pyright (ty is experimental)", () => {
    const config = resolveConfig({ banyan: true })
    expect(config.enabled).toBe(true)
    expect(builtinIds(config.servers)).toContain("typescript")
    expect(builtinIds(config.servers)).toContain("pyright")
    expect(builtinIds(config.servers)).not.toContain("ty")
    expect(config.idleTimeoutMs).toBe(5 * 60 * 1000)
  })

  test("experimental ty flag swaps pyright for ty", () => {
    const config = resolveConfig({ banyan: true, env: { OPENCODE_EXPERIMENTAL_LSP_TY: "1" } })
    expect(builtinIds(config.servers)).toContain("ty")
    expect(builtinIds(config.servers)).not.toContain("pyright")
  })

  test("banyancode_lsp=false disables the runtime", () => {
    const config = resolveConfig({ host: true, banyan: false })
    expect(config.enabled).toBe(false)
    expect(config.servers).toEqual({})
  })

  test("host lsp record is honoured when banyancode_lsp is unset", () => {
    const config = resolveConfig({
      host: { fixture: { command: ["fixture-bin"], extensions: [".fixture"] } },
    })
    expect(config.enabled).toBe(true)
    expect(config.servers.fixture?.extensions).toEqual([".fixture"])
    expect(builtinIds(config.servers)).toContain("typescript")
  })

  test("banyancode_lsp entries overlay host entries; disabled entries are reported", () => {
    const config = resolveConfig({
      host: { fixture: { command: ["host-bin"], extensions: [".fixture", ".host"] }, deny: { disabled: true } },
      banyan: {
        fixture: { command: ["banyan-bin"], extensions: [".fixture"] },
        typescript: { disabled: true },
      },
    })
    expect(config.servers.fixture?.extensions).toEqual([".fixture"])
    expect(config.servers.typescript).toBeUndefined()
    expect(config.disabled.get("typescript")).toBe("disabled in banyancode.json")
    expect(config.disabled.get("deny")).toBe("disabled in banyancode.json")
  })

  test("idle timeout: global value, zero disables, per-server override wins", () => {
    expect(resolveConfig({ banyan: true, banyanIdleTimeoutMs: 1200 }).idleTimeoutMs).toBe(1200)
    expect(resolveConfig({ banyan: true, banyanIdleTimeoutMs: 0 }).idleTimeoutMs).toBe(0)
    expect(resolveConfig({ banyan: true, banyanIdleTimeoutMs: "nope" }).idleTimeoutMs).toBe(5 * 60 * 1000)
    const perServer = resolveConfig({
      banyan: {
        fixture: { command: ["bin"], extensions: [".fixture"], idleTimeoutMs: 0 },
        other: { command: ["bin"], extensions: [".other"], idleTimeoutMs: 700 },
      },
    })
    expect(perServer.perServerIdleTimeoutMs.get("fixture")).toBe(0)
    expect(perServer.perServerIdleTimeoutMs.get("other")).toBe(700)
  })

  test("flags read both env prefixes", () => {
    expect(resolveFlags({ OPENCODE_DISABLE_LSP_DOWNLOAD: "1" }).disableLspDownload).toBe(true)
    expect(resolveFlags({ BANYANCODE_DISABLE_LSP_DOWNLOAD: "true" }).disableLspDownload).toBe(true)
    expect(resolveFlags({ OPENCODE_EXPERIMENTAL_LSP_TOOL: "1" }).experimentalLspTool).toBe(true)
    expect(resolveFlags({}).disableLspDownload).toBe(false)
  })

  test("typescript maxMemoryMb lands in initializationOptions.tsserver", async () => {
    const directory = await tempDir("memory")
    const command = fixtureCommand()
    const config = resolveConfig({
      banyan: { typescript: { command, extensions: [".fixture"], maxMemoryMb: 512 } },
    })
    const server = config.servers.typescript!
    const handle = await server.spawn(directory, { directory, worktree: directory }, config.flags)
    try {
      expect((handle?.initialization as { tsserver?: { maxTsServerMemory?: number } }).tsserver?.maxTsServerMemory).toBe(
        512,
      )
      const clamped = resolveConfig({
        banyan: {
          typescript: {
            command,
            extensions: [".fixture"],
            initialization: { tsserver: { maxTsServerMemory: 99 } },
          },
        },
      })
      const explicit = await clamped.servers.typescript!.spawn(
        directory,
        { directory, worktree: directory },
        clamped.flags,
      )
      try {
        expect(
          (explicit?.initialization as { tsserver?: { maxTsServerMemory?: number } }).tsserver?.maxTsServerMemory,
        ).toBe(256)
      } finally {
        if (explicit) await stop(explicit.process)
      }
    } finally {
      if (handle) await stop(handle.process)
      await cleanup(directory)
    }
  })

  test("readHostLsp prefers the nearest project file and ignores malformed json", async () => {
    const directory = await tempDir("host")
    const global = await tempDir("host-global")
    try {
      await write(join(directory, "banyancode.json"), JSON.stringify({ lsp: { project: { command: ["p"] } } }))
      await write(join(global, "banyancode.json"), JSON.stringify({ lsp: { global: { command: ["g"] } } }))
      const value = await readHostLsp({ directory, projectRoot: directory, globalDir: global, env: {}, home: global })
      expect(value).toEqual({ project: { command: ["p"] } })

      await write(join(directory, "banyancode.json"), "{ not json")
      const fallback = await readHostLsp({ directory, projectRoot: directory, globalDir: global, env: {}, home: global })
      expect(fallback).toEqual({ global: { command: ["g"] } })
    } finally {
      await cleanup(directory)
      await cleanup(global)
    }
  })

  test("coerceSetting drops non-record entries", () => {
    expect(coerceSetting({ a: 1, b: { command: ["x"] } })).toEqual({ b: { command: ["x"] } })
    expect(coerceSetting({ a: 1 })).toEqual({})
    expect(coerceSetting(true)).toBe(true)
  })
})

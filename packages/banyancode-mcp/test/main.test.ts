import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { main, parseArgv } from "../src/main"
import { basicAuthHeaders, defaultServiceFile, resolveServeCommand } from "../src/attach"
import { resolveServerVersion } from "../src/server"

describe("parseArgv", () => {
  test("defaults to serve and reads value/boolean flags", () => {
    const parsed = parseArgv(["--cwd", "x", "--http", "--port", "8080", "--tools", "task,code"])
    expect(parsed.command).toBe("serve")
    expect(parsed.flags.get("cwd")).toBe("x")
    expect(parsed.flags.get("http")).toBe(true)
    expect(parsed.flags.get("port")).toBe("8080")
    expect(parsed.flags.get("tools")).toBe("task,code")
  })

  test("supports --key=value, subcommands and positionals", () => {
    const parsed = parseArgv(["doctor", "--config=./banyan.json", "--json"])
    expect(parsed.command).toBe("doctor")
    expect(parsed.flags.get("config")).toBe("./banyan.json")
    expect(parsed.flags.get("json")).toBe(true)
  })

  test("a boolean flag never consumes the next token", () => {
    const parsed = parseArgv(["serve", "--no-start", "extra"])
    expect(parsed.flags.get("no-start")).toBe(true)
    expect(parsed.positional).toEqual(["extra"])
  })
})

describe("attach helpers", () => {
  test("serve command defaults to this binary and honors overrides", () => {
    const self = resolveServeCommand({})
    expect(self.slice(-2)).toEqual(["serve", "--service"])
    // Never a bare upstream `opencode`: a compiled binary re-execs itself.
    expect(self[0]).toBe(process.execPath)
    expect(self.map((part) => part.toLowerCase())).not.toContain("opencode")
    expect(resolveServeCommand({ BANYANCODE_BIN: "banyancode" })).toEqual(["banyancode", "serve", "--service"])
    expect(resolveServeCommand({ BANYANCODE_MCP_SERVE_COMMAND: '"my bin" serve --service' })).toEqual([
      "my bin",
      "serve",
      "--service",
    ])
  })

  test("basic auth uses the server's fixed username", () => {
    const header = basicAuthHeaders("secret").authorization
    expect(header?.startsWith("Basic ")).toBe(true)
    expect(Buffer.from(header!.slice(6), "base64").toString("utf8")).toBe("opencode:secret")
  })
})

describe("main", () => {
  test("doctor reports config and service state without writing anything", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "banyancode-mcp-doctor-"))
    const out: string[] = []
    const code = await main(["doctor", "--cwd", directory], {
      stdout: (text) => out.push(text),
      stderr: () => {},
      cwd: () => directory,
      env: {},
    })
    expect(code).toBe(0)
    const report = JSON.parse(out.join("\n")) as Record<string, unknown>
    expect(report["cwd"]).toBe(directory)
    expect(report["ok"]).toBe(true)
    expect(report["permission"]).toBe("reject")
    expect(report["autonomy"]).toContain("supervised")
  })

  test("profiles lists the built-ins", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "banyancode-mcp-profiles-"))
    const out: string[] = []
    const code = await main(["profiles", "--cwd", directory], {
      stdout: (text) => out.push(text),
      stderr: () => {},
      cwd: () => directory,
      env: {},
    })
    expect(code).toBe(0)
    const body = JSON.parse(out.join("\n")) as { profiles: Array<{ name: string }> }
    expect(body.profiles.map((profile) => profile.name)).toContain("observe")
    expect(body.profiles.map((profile) => profile.name)).toContain("trusted")
  })

  test("--help prints usage and unknown commands fail", async () => {
    const out: string[] = []
    const err: string[] = []
    const io = {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      cwd: () => process.cwd(),
      env: {},
    }
    expect(await main(["--help"], io)).toBe(0)
    expect(out.join("\n")).toContain("banyancode mcp")
    expect(await main(["nope"], io)).toBe(2)
    expect(err.join("\n")).toContain('unknown command "nope"')
  })
})

describe("argument validation", () => {
  const io = (out: string[], err: string[], env: NodeJS.ProcessEnv = {}) => ({
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    cwd: () => process.cwd(),
    env,
  })

  test("an unknown tool group is rejected instead of silently disabling every tool", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "banyancode-mcp-tools-"))
    const err: string[] = []
    const code = await main(["profiles", "--cwd", directory, "--tools", "bogus"], io([], err))
    expect(code).toBe(2)
    expect(err.join("\n")).toContain('unknown tool group "bogus"')
    expect(err.join("\n")).toContain("task, code")
  })

  test("--max-tasks outside 1-32 is rejected", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "banyancode-mcp-max-"))
    for (const value of ["99", "0", "abc"]) {
      const err: string[] = []
      const code = await main(["profiles", "--cwd", directory, "--max-tasks", value], io([], err))
      expect(code).toBe(2)
      expect(err.join("\n")).toContain("between 1 and 32")
    }
  })
})

describe("service file and version", () => {
  test("the default service file follows this build's channel", () => {
    const state = mkdtempSync(path.join(tmpdir(), "banyancode-mcp-state-"))
    expect(defaultServiceFile({ XDG_STATE_HOME: state, BANYANCODE_CHANNEL: "dev" })).toBe(
      path.join(state, "banyancode", "service-dev.json"),
    )
    expect(defaultServiceFile({ XDG_STATE_HOME: state, BANYANCODE_CHANNEL: "local" })).toBe(
      path.join(state, "banyancode", "service-local.json"),
    )
    expect(defaultServiceFile({ XDG_STATE_HOME: state, BANYANCODE_CHANNEL: "latest" })).toBe(
      path.join(state, "banyancode", "service.json"),
    )
    expect(defaultServiceFile({ XDG_STATE_HOME: state, BANYANCODE_CHANNEL: "beta" })).toBe(
      path.join(state, "banyancode", "service.json"),
    )
  })

  test("doctor finds the channel service file, not only service.json", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "banyancode-mcp-doctor-file-"))
    const state = mkdtempSync(path.join(tmpdir(), "banyancode-mcp-doctor-state-"))
    mkdirSync(path.join(state, "banyancode"), { recursive: true })
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname
        if (pathname === "/api/info") return Response.json({ version: "test", pid: process.pid })
        if (pathname === "/api/session") return Response.json({ data: [], cursor: {} })
        return new Response("not found", { status: 404 })
      },
    })
    const registration = path.join(state, "banyancode", "service-local.json")
    writeFileSync(
      registration,
      JSON.stringify({ url: `http://127.0.0.1:${server.port}`, pid: process.pid, version: "test" }),
    )
    try {
      const out: string[] = []
      const err: string[] = []
      const code = await main(["doctor", "--cwd", directory], {
        stdout: (value: string) => out.push(value),
        stderr: (value: string) => err.push(value),
        cwd: () => directory,
        env: { XDG_STATE_HOME: state },
      })
      expect(code).toBe(0)
      const report = JSON.parse(out.join("\n")) as Record<string, unknown>
      expect(report["service_file"]).toBe(registration)
      expect((report["service"] as Record<string, unknown>)["url"]).toBe(`http://127.0.0.1:${server.port}`)
      expect(report["tasks"]).toEqual([])
    } finally {
      server.stop(true)
    }
  })

  test("the MCP server version is the real app version, never a literal 0.0.0", () => {
    expect(resolveServerVersion({ BANYANCODE_VERSION: "26.11.0-dev.8f77dc8" }, undefined)).toBe(
      "26.11.0-dev.8f77dc8",
    )
    expect(resolveServerVersion({}, "26.11.0")).toBe("26.11.0")
    expect(resolveServerVersion({}, undefined)).toBe("0.0.0")
  })
})

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { main, parseArgv } from "../src/main"
import { basicAuthHeaders, resolveServeCommand } from "../src/attach"

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

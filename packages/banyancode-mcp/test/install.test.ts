// `banyancode mcp install` plans every write up-front, prints the exact
// change, and only touches the disk after confirmation (or --yes). Everything
// runs against temp directories: never a real ~/.claude.json or ~/.codex.

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { main } from "../src/main"
import { planInstall, mergeMcpJson, upsertTomlBlock, tomlBlock, SERVER_KEY } from "../src/install"
import { SKILL_MD, SKILL_NAME } from "../src/skill"

const temp = (prefix: string): string => mkdtempSync(path.join(tmpdir(), prefix))

const readJson = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>

describe("install plans", () => {
  test("claude-code writes a project .mcp.json plus the delegate skill", () => {
    const cwd = temp("banyancode-install-cc-")
    const home = temp("banyancode-install-cc-home-")
    const plan = planInstall({ client: "claude-code", cwd, home, selfCommand: ["/bin/banyancode"] })
    expect(plan.command).toEqual(["/bin/banyancode", "mcp", "serve", "--cwd", cwd])
    expect(plan.files.map((file) => file.path)).toEqual([
      path.join(cwd, ".mcp.json"),
      path.join(cwd, ".claude", "skills", SKILL_NAME, "SKILL.md"),
    ])
    const config = JSON.parse(plan.files[0]!.content) as {
      mcpServers: Record<string, { type: string; command: string; args: string[] }>
    }
    expect(config.mcpServers[SERVER_KEY]).toEqual({
      type: "stdio",
      command: "/bin/banyancode",
      args: ["mcp", "serve", "--cwd", cwd],
    })
    expect(plan.files[1]!.content).toBe(SKILL_MD)
    expect(plan.files.every((file) => file.changes)).toBe(true)
  })

  test("a permission choice is written into the server entry", () => {
    const cwd = temp("banyancode-install-permission-")
    const plan = planInstall({ client: "cursor", cwd, home: temp("h-"), selfCommand: ["/bin/banyancode"], permission: "edits" })
    expect(plan.command).toEqual(["/bin/banyancode", "mcp", "serve", "--cwd", cwd, "--permission", "edits"])
    const config = JSON.parse(plan.files[0]!.content) as { mcpServers: Record<string, { args: string[] }> }
    expect(config.mcpServers[SERVER_KEY]?.args).toEqual(["mcp", "serve", "--cwd", cwd, "--permission", "edits"])
  })

  test("cursor writes .cursor/mcp.json with the same stdio entry", () => {
    const cwd = temp("banyancode-install-cursor-")
    const plan = planInstall({ client: "cursor", cwd, home: temp("h-"), selfCommand: ["banyancode.exe"] })
    expect(plan.files).toHaveLength(1)
    expect(plan.files[0]!.path).toBe(path.join(cwd, ".cursor", "mcp.json"))
    const config = JSON.parse(plan.files[0]!.content) as { mcpServers: Record<string, unknown> }
    expect(config.mcpServers[SERVER_KEY]).toBeDefined()
  })

  test("codex writes a [mcp_servers.banyancode] block under CODEX_HOME", () => {
    const cwd = temp("banyancode-install-codex-")
    const home = temp("banyancode-install-codex-home-")
    const codexHome = path.join(home, "codex-home")
    const plan = planInstall({
      client: "codex",
      cwd,
      home,
      env: { CODEX_HOME: codexHome },
      selfCommand: ["C:\\tools\\banyancode.exe"],
    })
    expect(plan.files).toHaveLength(1)
    expect(plan.files[0]!.path).toBe(path.join(codexHome, "config.toml"))
    expect(plan.files[0]!.content).toContain("[mcp_servers.banyancode]")
    expect(plan.files[0]!.content).toContain('args = ["mcp", "serve", "--cwd"')
  })

  test("existing configs are preserved (JSON servers, TOML tables)", () => {
    const merged = mergeMcpJson(
      JSON.stringify({ mcpServers: { other: { command: "other" } }, theme: "dark" }, null, 2),
      SERVER_KEY,
      { type: "stdio", command: "banyan", args: [] },
    )
    const parsed = JSON.parse(merged) as Record<string, unknown>
    expect(parsed["theme"]).toBe("dark")
    expect((parsed["mcpServers"] as Record<string, unknown>)["other"]).toEqual({ command: "other" })
    expect((parsed["mcpServers"] as Record<string, unknown>)[SERVER_KEY]).toBeDefined()

    const toml = ['model = "o3"', "", "[mcp_servers.other]", 'command = "other"', ""].join("\n")
    const block = tomlBlock(SERVER_KEY, { command: "banyan", args: ["mcp", "serve"] })
    const applied = upsertTomlBlock(toml, SERVER_KEY, block)
    expect(applied).toContain('model = "o3"')
    expect(applied).toContain("[mcp_servers.other]")
    expect(applied).toContain("[mcp_servers.banyancode]")

    const replaced = upsertTomlBlock(applied, SERVER_KEY, tomlBlock(SERVER_KEY, { command: "newbin", args: [] }))
    expect(replaced.match(/\[mcp_servers\.banyancode\]/g)).toHaveLength(1)
    expect(replaced).toContain('command = "newbin"')
    expect(replaced).not.toContain('command = "banyan"')
  })

  test("the checked-in skill matches the embedded installer copy", () => {
    const file = path.resolve(import.meta.dir, "..", "skills", SKILL_NAME, "SKILL.md")
    expect(readFileSync(file, "utf8")).toBe(SKILL_MD)
    expect(SKILL_MD).toContain("banyan_checkup")
    expect(SKILL_MD).toContain("banyan_task_start")
  })
})

describe("install command", () => {
  const run = async (argv: string[], cwd: string, home: string, answer = false) => {
    const out: string[] = []
    const err: string[] = []
    const code = await main(argv, {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      cwd: () => cwd,
      env: { HOME: home, USERPROFILE: home },
      prompt: async () => answer,
    })
    return { code, out: out.join("\n"), err: err.join("\n") }
  }

  test("prints the change and writes only with --yes", async () => {
    const cwd = temp("banyancode-install-yes-")
    const home = temp("banyancode-install-yes-home-")
    const result = await run(["install", "claude-code", "--cwd", cwd, "--yes"], cwd, home)
    expect(result.code).toBe(0)
    expect(result.out).toContain(".mcp.json")
    expect(result.out).toContain("mcpServers")
    expect(result.out).toContain(`wrote ${path.join(cwd, ".mcp.json")}`)
    const config = readJson(path.join(cwd, ".mcp.json"))
    expect((config["mcpServers"] as Record<string, unknown>)[SERVER_KEY]).toBeDefined()
    expect(existsSync(path.join(cwd, ".claude", "skills", SKILL_NAME, "SKILL.md"))).toBe(true)
  })

  test("declining the prompt writes nothing", async () => {
    const cwd = temp("banyancode-install-no-")
    const home = temp("banyancode-install-no-home-")
    const result = await run(["install", "cursor", "--cwd", cwd], cwd, home, false)
    expect(result.code).toBe(2)
    expect(result.err).toContain("nothing written")
    expect(existsSync(path.join(cwd, ".cursor", "mcp.json"))).toBe(false)
  })

  test("accepting the prompt writes the config", async () => {
    const cwd = temp("banyancode-install-accept-")
    const home = temp("banyancode-install-accept-home-")
    const codexHome = path.join(home, ".codex")
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(path.join(codexHome, "config.toml"), 'approval_policy = "never"\n', "utf8")
    const out: string[] = []
    const code = await main(["install", "codex", "--cwd", cwd], {
      stdout: (line) => out.push(line),
      stderr: () => {},
      cwd: () => cwd,
      env: { HOME: home, USERPROFILE: home },
      prompt: async () => true,
    })
    expect(code).toBe(0)
    const text = readFileSync(path.join(codexHome, "config.toml"), "utf8")
    expect(text).toContain('approval_policy = "never"')
    expect(text).toContain("[mcp_servers.banyancode]")
  })

  test("an unknown client is rejected without writing", async () => {
    const cwd = temp("banyancode-install-bad-")
    const home = temp("banyancode-install-bad-home-")
    const result = await run(["install", "vim", "--cwd", cwd, "--yes"], cwd, home)
    expect(result.code).toBe(2)
    expect(result.err).toContain("unknown client")
    expect(existsSync(path.join(cwd, ".mcp.json"))).toBe(false)
  })
})

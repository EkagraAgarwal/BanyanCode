import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { globalConfigDir, load } from "../src/config/loader.js"
import { parseJsonc, stripJsonc } from "../src/config/jsonc.js"

const withTemp = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-config-"))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

describe("banyancode config", () => {
  test("project config wins over global and unknown keys are reported", async () => {
    await withTemp(async (directory) => {
      const globalDir = join(directory, "global")
      const project = join(directory, "project")
      await mkdir(globalDir, { recursive: true })
      await mkdir(join(project, ".banyancode"), { recursive: true })
      await writeFile(
        join(globalDir, "banyancode.json"),
        JSON.stringify({ banyancode_max_subagents: 3, banyancode_yolo_mode: true }),
      )
      const projectFile = join(project, ".banyancode", "banyancode.json")
      await writeFile(
        projectFile,
        JSON.stringify({
          banyancode_max_subagents: 7,
          banyancode_unknown_key: true,
          agent: { coder: { thinking: "high", thinkingg: "typo" } },
        }),
      )

      const loaded = await load({ directory: project, projectRoot: project, globalDir })
      expect(loaded.config.banyancode_max_subagents).toBe(7)
      expect(loaded.config.banyancode_yolo_mode).toBe(true)
      expect(loaded.config.agent?.coder?.thinking).toBe("high")
      expect(loaded.sources.map((source) => source.scope)).toEqual(["global", "project"])
      expect(loaded.unknownKeys).toEqual([
        { file: projectFile, keys: ["banyancode_unknown_key", "agent.coder.thinkingg"] },
      ])
      expect(loaded.errors).toEqual([])
    })
  })

  test("host-owned keys from the host config schema are not reported as unknown", async () => {
    await withTemp(async (directory) => {
      const project = join(directory, "project")
      await mkdir(project, { recursive: true })
      const projectFile = join(project, "banyancode.json")
      await writeFile(
        projectFile,
        JSON.stringify({
          $schema: "https://banyan.dev/schema/banyancode.json",
          model: "opencode-go/deepseek-v4.1-flash",
          default_agent: "build",
          permissions: { edit: "allow" },
          agents: { plan: { model: "x/y" } },
          mcp: { server: { type: "local" } },
          providers: {},
          instructions: ["AGENTS.md"],
          banyancode_yolo_mode: true,
          banyancode_only_typo: 1,
        }),
      )

      const loaded = await load({ directory: project, projectRoot: project, globalDir: join(directory, "missing") })
      expect(loaded.unknownKeys).toEqual([{ file: projectFile, keys: ["banyancode_only_typo"] }])
      expect(loaded.errors).toEqual([])
      expect(loaded.config.banyancode_yolo_mode).toBe(true)
    })
  })

  test("one invalid value drops only that key and names it in errors", async () => {
    await withTemp(async (directory) => {
      const project = join(directory, "project")
      await mkdir(project, { recursive: true })
      const projectFile = join(project, "banyancode.json")
      await writeFile(
        projectFile,
        JSON.stringify({
          banyancode_disable_websearch: true,
          banyancode_router: "bogus",
          banyancode_max_subagents: "lots",
          agent: { coder: { thinking: "high", enabled: "yes" } },
        }),
      )

      const loaded = await load({ directory: project, projectRoot: project, globalDir: join(directory, "missing") })
      expect(loaded.config.banyancode_disable_websearch).toBe(true)
      expect(loaded.config.banyancode_router).toBeUndefined()
      expect(loaded.config.banyancode_max_subagents).toBeUndefined()
      expect(loaded.config.agent?.coder?.thinking).toBe("high")
      expect(loaded.config.agent?.coder?.enabled).toBeUndefined()
      expect(loaded.errors.map((error) => error.file)).toEqual([projectFile, projectFile, projectFile])
      expect(loaded.errors.map((error) => error.message.split(":")[0])).toEqual([
        "banyancode_router",
        "banyancode_max_subagents",
        "agent.coder.enabled",
      ])
      expect(loaded.errors[0]?.message).toContain("off")
      expect(loaded.errors[0]?.message).toContain("banyancode_router")
    })
  })

  test("nearest project config wins over an ancestor config", async () => {
    await withTemp(async (directory) => {
      const project = join(directory, "project")
      const nested = join(project, "packages", "app")
      await mkdir(nested, { recursive: true })
      await writeFile(join(project, "banyancode.json"), JSON.stringify({ banyancode_max_subagents: 4 }))
      await writeFile(join(nested, "banyancode.json"), JSON.stringify({ banyancode_max_subagents: 9 }))

      const loaded = await load({ directory: nested, projectRoot: project, globalDir: join(directory, "missing") })
      expect(loaded.config.banyancode_max_subagents).toBe(9)
      expect(loaded.sources.map((source) => source.file)).toEqual([
        join(project, "banyancode.json"),
        join(nested, "banyancode.json"),
      ])
    })
  })

  test("jsonc comments and trailing commas parse without touching strings", () => {
    expect(
      parseJsonc(`{
        // line comment
        "banyancode_max_subagents": 4,
        /* block comment */
        "agent": { "coder": { "thinking": "high", }, },
      }`),
    ).toEqual({ banyancode_max_subagents: 4, agent: { coder: { thinking: "high" } } })
    expect(parseJsonc(`{"url":"https://example.com//path"}`)).toEqual({ url: "https://example.com//path" })
    expect(stripJsonc('{"text":"a /* not a comment */ b"}')).toBe('{"text":"a /* not a comment */ b"}')
  })

  test("global config dir follows BANYANCODE_CONFIG_DIR, XDG, then ~/.config", () => {
    expect(globalConfigDir({ BANYANCODE_CONFIG_DIR: join("/custom", "banyan") } as NodeJS.ProcessEnv, "/home/u")).toBe(
      join("/custom", "banyan"),
    )
    expect(globalConfigDir({ XDG_CONFIG_HOME: join("/xdg", "config") } as NodeJS.ProcessEnv, "/home/u")).toBe(
      join("/xdg", "config", "banyancode"),
    )
    expect(globalConfigDir({} as NodeJS.ProcessEnv, "/home/u")).toBe(join("/home/u", ".config", "banyancode"))
  })
})

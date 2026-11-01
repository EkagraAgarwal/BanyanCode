import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { findConfigPath, resolveConfig, stripJsonc } from "../src/config"

const temp = (): string => mkdtempSync(path.join(tmpdir(), "banyancode-mcp-config-"))

describe("stripJsonc", () => {
  test("removes line and block comments outside strings", () => {
    const input = `{
      // leading comment
      "a": 1, /* inline */
      "b": "http://example.com//path",
      "c": "/* not a comment */",
    }`
    expect(JSON.parse(stripJsonc(input))).toEqual({ a: 1, b: "http://example.com//path", c: "/* not a comment */" })
  })

  test("preserves escaped quotes in strings", () => {
    expect(JSON.parse(stripJsonc('{"a":"x\\"//y"}'))).toEqual({ a: 'x"//y' })
  })
})

describe("findConfigPath", () => {
  test("walks up from the cwd", () => {
    const root = temp()
    const nested = path.join(root, "packages", "app")
    writeFileSync(path.join(root, "banyancode.json"), "{}")
    const fsRoot = path.parse(root).root
    expect(findConfigPath({ cwd: nested, home: path.join(fsRoot, "nonexistent-home") })).toBe(
      path.join(root, "banyancode.json"),
    )
  })

  test("explicit path wins over discovery", () => {
    const root = temp()
    writeFileSync(path.join(root, "banyancode.json"), "{}")
    expect(findConfigPath({ cwd: root, explicit: "custom.json", home: root })).toBe(path.join(root, "custom.json"))
  })

  test("BANYANCODE_CONFIG wins over discovery, BANYANCODE_CONFIG_DIR is searched", () => {
    const root = temp()
    writeFileSync(path.join(root, "banyancode.json"), "{}")
    const fromEnv = findConfigPath({ cwd: root, env: { BANYANCODE_CONFIG: "env.json" }, home: path.parse(root).root })
    expect(fromEnv?.endsWith("env.json")).toBe(true)
    expect(
      findConfigPath({ cwd: root, env: { BANYANCODE_CONFIG_DIR: root }, home: path.parse(root).root }),
    ).toBe(path.join(root, "banyancode.json"))
  })
})

describe("resolveConfig", () => {
  test("defaults when no file exists", () => {
    const root = temp()
    const config = resolveConfig({ cwd: root, configPath: path.join(root, "missing.json"), env: {} })
    expect(config.permission).toBe("reject")
    expect(config.maxConcurrentTasks).toBe(4)
    expect(config.taskBudgetUsd).toBe(5)
    expect(config.worktree).toBe("shared")
    expect(config.autonomy.profiles).toEqual({})
  })

  test("reads banyancode_mcp_server, ignores unknown keys", () => {
    const root = temp()
    writeFileSync(
      path.join(root, "banyancode.json"),
      JSON.stringify({
        banyancode_mcp_server: {
          default_agent: "coder",
          permission: "edits",
          max_concurrent_tasks: 2,
          task_budget_usd: 1.5,
          worktree: "new",
          tools: ["task"],
          autonomy: {
            default: "trusted",
            auto_answer_after_seconds: 5,
            profiles: { trusted: { rules: [{ action: "edit", resource: "*", effect: "allow" }] } },
          },
        },
        some_other_key: true,
      }),
    )
    const config = resolveConfig({ cwd: root, env: {} })
    expect(config.defaultAgent).toBe("coder")
    expect(config.permission).toBe("edits")
    expect(config.maxConcurrentTasks).toBe(2)
    expect(config.taskBudgetUsd).toBe(1.5)
    expect(config.worktree).toBe("new")
    expect(config.toolGroups).toEqual(["task"])
    expect(config.autonomy.default).toBe("trusted")
    expect(config.autonomy.auto_answer_after_seconds).toBe(5)
    expect(config.autonomy.profiles["trusted"]?.rules[0]?.effect).toBe("allow")
  })

  test("stored config can never express yolo; --allow-yolo selects it", () => {
    const root = temp()
    writeFileSync(
      path.join(root, "banyancode.json"),
      JSON.stringify({ banyancode_mcp_server: { permission: "edits" } }),
    )
    expect(resolveConfig({ cwd: root, env: {} }).permission).toBe("edits")
    expect(resolveConfig({ cwd: root, env: {}, allowYolo: true }).permission).toBe("yolo")
    expect(resolveConfig({ cwd: root, env: {}, permission: "reject", allowYolo: true }).permission).toBe("reject")
    expect(resolveConfig({ cwd: root, env: { BANYANCODE_MCP_ALLOW_YOLO: "1" } }).permission).toBe("yolo")
  })

  test("env overrides win over the file", () => {
    const root = temp()
    writeFileSync(
      path.join(root, "banyancode.json"),
      JSON.stringify({ banyancode_mcp_server: { max_concurrent_tasks: 2, output_max_chars: 2000 } }),
    )
    const config = resolveConfig({
      cwd: root,
      env: { BANYANCODE_MCP_MAX_TASKS: "6", BANYANCODE_MCP_OUTPUT_CHARS: "4000" },
    })
    expect(config.maxConcurrentTasks).toBe(6)
    expect(config.outputMaxChars).toBe(4000)
  })

  test("the v1 permission policy picks the matching autonomy profile unless one is configured", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "banyancode-mcp-config-"))
    const missing = path.join(dir, "missing.json")
    const base = { cwd: dir, configPath: missing, env: {} }
    expect(resolveConfig({ ...base, permission: "edits" }).autonomy.default).toBe("trusted")
    expect(resolveConfig({ ...base, permission: "yolo", allowYolo: true }).autonomy.default).toBe("yolo")
    expect(resolveConfig({ ...base, permission: "reject" }).autonomy.default).toBeUndefined()
    expect(resolveConfig(base).autonomy.default).toBeUndefined()

    const file = path.join(dir, "banyancode.json")
    writeFileSync(file, JSON.stringify({ banyancode_mcp_server: { autonomy: { default: "observe" } } }))
    expect(resolveConfig({ ...base, configPath: file, permission: "edits" }).autonomy.default).toBe("observe")
  })

  test("unparseable files degrade to defaults", () => {
    const root = temp()
    writeFileSync(path.join(root, "banyancode.json"), "{ this is not json")
    const config = resolveConfig({ cwd: root, env: {} })
    expect(config.permission).toBe("reject")
    expect(config.maxConcurrentTasks).toBe(4)
  })
})

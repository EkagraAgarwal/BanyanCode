import { describe, expect, test } from "bun:test"
import { thinkingLevelOptions } from "../../src/component/dialog-thinking"

describe("thinkingLevelOptions", () => {
  test("all seven levels render with no filter", () => {
    const options = thinkingLevelOptions(undefined)
    expect(options.map((o) => o.value)).toEqual(["off", "low", "medium", "high", "max", "xhigh", "ultra"])
    expect(options.every((o) => o.disabled !== true)).toBe(true)
  })

  test("levels are filtered to the model's variant keys, off always stays", () => {
    const options = thinkingLevelOptions(["low", "medium", "high", "max"])
    const enabled = options.filter((o) => o.disabled !== true).map((o) => o.value)
    expect(enabled).toEqual(["off", "low", "medium", "high", "max"])
  })

  test("empty variant set disables everything except off", () => {
    const options = thinkingLevelOptions([])
    const enabled = options.filter((o) => o.disabled !== true).map((o) => o.value)
    expect(enabled).toEqual(["off"])
  })
})

describe("tab-agents thinking wiring (source)", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const tabAgents = () =>
    fs.readFileSync(path.resolve(__dirname, "../../src/feature-plugins/tabs/tab-agents.tsx"), "utf8")
  const dialogThinking = () =>
    fs.readFileSync(path.resolve(__dirname, "../../src/component/dialog-thinking.tsx"), "utf8")
  const dialogAgentConfig = () =>
    fs.readFileSync(path.resolve(__dirname, "../../src/component/dialog-agent-config.tsx"), "utf8")

  test("AgentCard renders a Thinking row that opens the picker", () => {
    const source = tabAgents()
    expect(source).toContain("Thinking")
    expect(source).toContain("thinkingLabel")
    expect(source).toContain("onOpenThinking")
    expect(source).toContain("openThinkingPicker")
    expect(source).toContain("DialogThinking")
  })

  test("thinking picker uses optimistic update plus revert via banyanAgentOverride.update", () => {
    const source = tabAgents()
    const pickerMatch = source.match(/const openThinkingPicker[\s\S]*?\n  \}\n/)
    expect(pickerMatch).toBeTruthy()
    const body = pickerMatch![0]
    expect(body).toContain("// Optimistic update")
    const optimisticIdx = body.indexOf("// Optimistic update")
    const apiCallIdx = body.indexOf("banyanAgentOverride.update({ name, thinking })")
    expect(apiCallIdx).toBeGreaterThan(optimisticIdx)
    expect(body).toContain("Revert to the exact prior entry")
  })

  test("dialog-thinking filters by the agent model variants and handles empty sets", () => {
    const source = dialogThinking()
    expect(source).toContain("DialogSelect")
    expect(source).toContain("thinkingLevelOptions")
    expect(source).toContain("data.location.model")
    expect(source).toContain("No thinking levels for this model")
  })

  test("dialog-agent-config has a thinking step persisted via banyanAgent.save", () => {
    const source = dialogAgentConfig()
    expect(source).toContain('"thinking"')
    expect(source).toContain("Step 4/5: Thinking")
    expect(source).toContain("thinking: result.thinking")
    expect(source).toContain("Thinking: {thinking()")
  })
})

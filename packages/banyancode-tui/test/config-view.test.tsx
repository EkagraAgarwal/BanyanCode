/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { AgentInfo, ModelInfo } from "@opencode/client"
import { ConfigView } from "../src/components/panels/config"
import type { BanyanConfig } from "../src/data/pending-rpc"
import { context, live, mount } from "./harness"

function agent(input: {
  readonly name: string
  readonly mode: AgentInfo["mode"]
  readonly description?: string
  readonly model?: { readonly providerID: string; readonly modelID: string }
  readonly system?: string
}): AgentInfo {
  return {
    id: input.name,
    name: input.name,
    mode: input.mode,
    hidden: false,
    description: input.description,
    system: input.system,
    model: input.model ? { providerID: input.model.providerID, id: input.model.modelID } : undefined,
    request: {},
    permissions: [],
  } as unknown as AgentInfo
}

const models: ModelInfo[] = [
  { providerID: "anthropic", modelID: "claude-sonnet", name: "Claude Sonnet" },
  { providerID: "openai", modelID: "gpt-5", name: "GPT-5" },
] as unknown as ModelInfo[]

const config = {
  banyancode_thinking_default: "medium",
  agent: {
    coder: { enabled: false, model: "anthropic/claude-sonnet", thinking: "high", prompt: "You are a coder." },
  },
} as unknown as BanyanConfig

test("config view lists the orchestrator and subagents with overrides", async () => {
  const app = await mount(
    () => (
      <ConfigView
        context={context({
          agents: [
            agent({ name: "build", mode: "primary", description: "Full access." }),
            agent({ name: "coder", mode: "subagent", description: "Focused code changes." }),
          ],
          models,
        })}
        live={live({ core: { config } })}
      />
    ),
    { width: 100, height: 30 },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Agents")
    expect(frame).toContain("ORCHESTRATOR")
    expect(frame).toContain("SUBAGENTS")
    expect(frame).toContain("orchestrator")
    expect(frame).toContain("coder")
    expect(frame).toContain("[off]")
    expect(frame).toContain("anthropic/claude-sonnet")
    expect(frame).toContain("high")
    expect(frame).toContain("edit system prompt")
  } finally {
    app.renderer.destroy()
  }
})

test("a long model id keeps the model row on one line", async () => {
  const longModel = "provider/this-model-id-is-deliberately-long-enough-to-overflow-the-row"
  const longConfig = {
    banyancode_thinking_default: "medium",
    agent: {
      coder: { model: longModel, thinking: "high" },
    },
  } as unknown as BanyanConfig
  const app = await mount(
    () => (
      <ConfigView
        context={context({
          agents: [
            agent({ name: "build", mode: "primary" }),
            agent({ name: "coder", mode: "subagent" }),
          ],
          models,
        })}
        live={live({ core: { config: longConfig } })}
      />
    ),
    { width: 90, height: 20 },
  )

  try {
    const lines = app.captureCharFrame().split("\n")
    const modelRow = lines.find((line) => line.includes("Model") && line.includes("Thinking"))
    expect(modelRow).toBeDefined()
    expect(modelRow).toContain("Prompt")
    expect(modelRow).not.toContain(longModel)
  } finally {
    app.renderer.destroy()
  }
})

test("config view shows the unavailable hint when config RPC is missing", async () => {
  const app = await mount(
    () => (
      <ConfigView
        context={context({ agents: [agent({ name: "build", mode: "primary" })] })}
        live={live({ core: { availability: "unavailable" } })}
      />
    ),
    { width: 100, height: 20 },
  )

  try {
    expect(app.captureCharFrame()).toContain("Config RPC is not available")
  } finally {
    app.renderer.destroy()
  }
})
